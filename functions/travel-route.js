"use strict";

// Route proxy for the Android app. The phone sends a structured trip; this builds the TomTom or
// Google request with a server-held key, so no routing key ships in the app. The provider's
// status and body go back unchanged (minus the key), and the app parses them as before.

const TOMTOM_URL = "https://api.tomtom.com/routing/1/calculateRoute";
const GOOGLE_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const GOOGLE_FIELD_MASK = "routes.duration,routes.staticDuration,routes.distanceMeters";
const GOOGLE_TRANSIT_FIELD_MASK =
  `${GOOGLE_FIELD_MASK},routes.legs.steps.transitDetails,routes.legs.steps.staticDuration`;

const MODES = new Set(["DRIVE", "TRANSIT", "BICYCLE", "WALK"]);
const PREFERENCES = new Set(["TRAFFIC_UNAWARE", "TRAFFIC_AWARE"]);
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DEFAULT_LEAD_MS = 30 * MINUTE_MS;
const MINIMUM_FUTURE_DEPARTURE_MS = MINUTE_MS;
const MAX_DESTINATION_CHARS = 300;
const MAX_BODY_CHARS = 200_000;
// The app allows 60 calls a local day on Premium and 30 otherwise. The server counts UTC days,
// which can straddle two local ones, so its ceiling sits above the app's.
const DAILY_CALLS_PER_INSTALL = 80;
const PROVIDER_TIMEOUT_MS = 10_000;

class RouteRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function invalid(message) {
  return new RouteRequestError("invalid-argument", message);
}

function coordinate(value, name) {
  const latitude = value?.latitude;
  const longitude = value?.longitude;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw invalid(`${name} must be a latitude and longitude`);
  }
  return { latitude, longitude };
}

function timestamp(value, name, now, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return null;
  if (!Number.isFinite(value) || value < now - DAY_MS || value > now + 90 * DAY_MS) {
    throw invalid(`${name} must be a time within the planning window`);
  }
  return value;
}

/** Validates the phone's request; only these fields reach a provider. */
function parseRouteRequest(data, now = Date.now()) {
  if (!data || typeof data !== "object") throw invalid("Missing route request");
  const provider = data.provider;
  if (provider !== "tomtom" && provider !== "google") throw invalid("Unknown route provider");
  const installId = data.installId;
  if (typeof installId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(installId)) {
    throw invalid("Missing install id");
  }
  const mode = data.mode;
  if (!MODES.has(mode)) throw invalid("Unknown travel mode");
  const routingPreference = data.routingPreference ?? "TRAFFIC_UNAWARE";
  if (!PREFERENCES.has(routingPreference)) throw invalid("Unknown routing preference");
  const request = {
    provider,
    installId,
    mode,
    routingPreference,
    origin: coordinate(data.origin, "origin"),
    arriveByMillis: timestamp(data.arriveByMillis, "arriveByMillis", now),
    departureAtMillis: timestamp(data.departureAtMillis, "departureAtMillis", now, { optional: true }),
  };
  if (provider === "tomtom") {
    if (mode === "TRANSIT") throw invalid("TomTom does not route public transit");
    request.destination = coordinate(data.destinationCoordinate, "destinationCoordinate");
  } else {
    const destination = data.destination;
    if (typeof destination !== "string" || destination.trim().length === 0 ||
      destination.length > MAX_DESTINATION_CHARS) {
      throw invalid("destination must be an address");
    }
    request.destination = destination;
  }
  return request;
}

function departureMillis(request, now) {
  return Math.max(
    request.departureAtMillis ?? request.arriveByMillis - DEFAULT_LEAD_MS,
    now + MINIMUM_FUTURE_DEPARTURE_MS,
  );
}

function tomTomDepartAt(millis) {
  // A numeric offset, as TomTom's documentation shows, rather than "Z".
  return `${new Date(millis).toISOString().slice(0, 19)}+00:00`;
}

/**
 * A summary-only TomTom route. Live traffic is for traffic-aware drives; other drives still
 * depart at the trip's time so TomTom applies the typical traffic for that hour rather than now.
 */
function tomTomUrl(request, apiKey, now = Date.now()) {
  const point = ({ latitude, longitude }) => `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
  const url = new URL(`${TOMTOM_URL}/${point(request.origin)}:${point(request.destination)}/json`);
  const drive = request.mode === "DRIVE";
  const liveTraffic = drive && request.routingPreference === "TRAFFIC_AWARE";
  url.searchParams.set("travelMode", { DRIVE: "car", BICYCLE: "bicycle", WALK: "pedestrian" }[request.mode]);
  url.searchParams.set("traffic", String(liveTraffic));
  url.searchParams.set("routeRepresentation", "summaryOnly");
  // Reports the typical-traffic time alongside the live one, for "heavy traffic".
  if (liveTraffic) url.searchParams.set("computeTravelTimeFor", "all");
  if (drive) url.searchParams.set("departAt", tomTomDepartAt(departureMillis(request, now)));
  url.searchParams.set("key", apiKey);
  return url;
}

/** The Routes API request: arrive-by for transit, traffic-aware departure for driving only. */
function googleBody(request, now = Date.now()) {
  const body = {
    origin: { location: { latLng: request.origin } },
    destination: { address: request.destination },
    travelMode: request.mode,
  };
  if (request.mode === "TRANSIT") {
    body.arrivalTime = new Date(request.arriveByMillis).toISOString();
  } else if (request.mode === "DRIVE") {
    // Routes API rejects a routing preference for bicycling and walking.
    body.routingPreference = request.routingPreference;
    if (request.routingPreference === "TRAFFIC_AWARE") {
      body.departureTime = new Date(departureMillis(request, now)).toISOString();
    }
  }
  return body;
}

function scrub(body, apiKey) {
  const text = typeof body === "string" ? body.slice(0, MAX_BODY_CHARS) : "";
  return apiKey ? text.split(apiKey).join("[key]") : text;
}

/**
 * Counts one call against the install's allowance for the UTC day, in a transaction so
 * concurrent calls cannot both take the last one. Throws resource-exhausted past the ceiling.
 */
async function spendInstallAllowance(db, installId, now = Date.now(), limit = DAILY_CALLS_PER_INSTALL) {
  const day = new Date(now).toISOString().slice(0, 10);
  const ref = db.collection("travelRouteUsage").doc(installId);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const stored = snapshot.exists ? snapshot.data() : null;
    const count = stored?.day === day ? stored.count : 0;
    if (count >= limit) {
      throw new RouteRequestError("resource-exhausted", "Daily route allowance used");
    }
    // expiresAt lets a Firestore TTL policy drop idle installs.
    transaction.set(ref, { day, count: count + 1, expiresAt: new Date(now + 2 * DAY_MS) });
  });
}

/**
 * Runs one routed call. [fetchImpl] and [keys] are injected so tests need no network or secrets.
 * Resolves to the provider's { status, body }; throws RouteRequestError for refused requests.
 */
async function routeTrip({ data, db, keys, fetchImpl = fetch, logger, now = Date.now() }) {
  const request = parseRouteRequest(data, now);
  const apiKey = request.provider === "tomtom" ? keys.tomtom() : keys.google();
  if (!apiKey) {
    throw new RouteRequestError("failed-precondition", `${request.provider} routing is not configured`);
  }
  await spendInstallAllowance(db, request.installId, now);
  let response;
  let body;
  try {
    response = request.provider === "tomtom"
      ? await fetchImpl(tomTomUrl(request, apiKey, now), { signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) })
      : await fetchImpl(GOOGLE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": request.mode === "TRANSIT" ? GOOGLE_TRANSIT_FIELD_MASK : GOOGLE_FIELD_MASK,
        },
        body: JSON.stringify(googleBody(request, now)),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    body = scrub(await response.text(), apiKey);
  } catch (error) {
    // Never log the error itself: a fetch failure can echo the TomTom URL, which carries the key.
    logger?.warn("Route provider unreachable", { provider: request.provider, name: error?.name });
    throw new RouteRequestError("unavailable", "Route provider unreachable");
  }
  if (!response.ok) {
    logger?.warn("Route provider refused", { provider: request.provider, status: response.status });
  }
  return { status: response.status, body };
}

module.exports = {
  DAILY_CALLS_PER_INSTALL,
  RouteRequestError,
  googleBody,
  parseRouteRequest,
  routeTrip,
  spendInstallAllowance,
  tomTomUrl,
};

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { FakeFirestore } = require("../testing/fake-firestore");
const {
  DAILY_CALLS_PER_INSTALL,
  DAILY_CALLS_PER_PROVIDER,
  HOURLY_CALLS_PER_NETWORK,
  googleBody,
  parseRouteRequest,
  routeTrip,
  tomTomUrl,
} = require("../travel-route");

const NOW = Date.parse("2026-10-13T15:00:00Z");
const KEY = "server-key-123";

function trip(overrides = {}) {
  return {
    provider: "tomtom",
    installId: "install-abc123",
    origin: { latitude: 37.7955, longitude: -122.3937 },
    destination: "SFO, San Francisco, CA",
    destinationCoordinate: { latitude: 37.6213, longitude: -122.379 },
    mode: "DRIVE",
    arriveByMillis: NOW + 2 * 3_600_000,
    routingPreference: "TRAFFIC_UNAWARE",
    ...overrides,
  };
}

function fakeFetch(status = 200, body = '{"routes":[]}') {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { calls, impl };
}

const keys = { tomtom: () => KEY, google: () => KEY };

test("a basic TomTom drive departs at the trip's time with typical traffic", () => {
  const url = tomTomUrl(parseRouteRequest(trip(), NOW), KEY, NOW);
  assert.equal(url.pathname, "/routing/1/calculateRoute/37.795500,-122.393700:37.621300,-122.379000/json");
  assert.equal(url.searchParams.get("travelMode"), "car");
  assert.equal(url.searchParams.get("traffic"), "false");
  assert.equal(url.searchParams.get("departAt"), "2026-10-13T16:30:00+00:00");
  assert.equal(url.searchParams.get("computeTravelTimeFor"), null);
});

test("a traffic-aware TomTom drive asks for live and typical times", () => {
  const request = parseRouteRequest(trip({
    routingPreference: "TRAFFIC_AWARE",
    departureAtMillis: NOW + 3_600_000,
  }), NOW);
  const url = tomTomUrl(request, KEY, NOW);
  assert.equal(url.searchParams.get("traffic"), "true");
  assert.equal(url.searchParams.get("computeTravelTimeFor"), "all");
  assert.equal(url.searchParams.get("departAt"), "2026-10-13T16:00:00+00:00");
});

test("TomTom walks and rides carry no departure time", () => {
  const url = tomTomUrl(parseRouteRequest(trip({ mode: "WALK" }), NOW), KEY, NOW);
  assert.equal(url.searchParams.get("travelMode"), "pedestrian");
  assert.equal(url.searchParams.get("departAt"), null);
});

test("Google transit arrives by the target; drives send a routing preference", () => {
  const transit = googleBody(parseRouteRequest(trip({ provider: "google", mode: "TRANSIT" }), NOW), NOW);
  assert.equal(transit.arrivalTime, "2026-10-13T17:00:00.000Z");
  assert.equal(transit.routingPreference, undefined);
  assert.deepEqual(transit.destination, { address: "SFO, San Francisco, CA" });

  const drive = googleBody(parseRouteRequest(trip({ provider: "google", routingPreference: "TRAFFIC_AWARE" }), NOW), NOW);
  assert.equal(drive.routingPreference, "TRAFFIC_AWARE");
  assert.equal(drive.departureTime, "2026-10-13T16:30:00.000Z");

  const bike = googleBody(parseRouteRequest(trip({ provider: "google", mode: "BICYCLE" }), NOW), NOW);
  assert.equal(bike.routingPreference, undefined);
});

test("requests outside the contract are refused before any provider call", () => {
  for (const bad of [
    trip({ provider: "here" }),
    trip({ installId: "x" }),
    trip({ mode: "FLY" }),
    trip({ origin: { latitude: 91, longitude: 0 } }),
    trip({ arriveByMillis: NOW + 400 * 86_400_000 }),
    trip({ mode: "TRANSIT" }),
    trip({ provider: "google", destination: "" }),
    trip({ provider: "google", destination: "x".repeat(301) }),
  ]) {
    assert.throws(() => parseRouteRequest(bad, NOW), { code: "invalid-argument" });
  }
});

test("the proxy returns the provider's answer with the key scrubbed", async () => {
  const fetch = fakeFetch(403, `{"error":"bad key ${KEY}"}`);
  const result = await routeTrip({ data: trip(), db: new FakeFirestore(), keys, fetchImpl: fetch.impl, now: NOW });
  assert.equal(result.status, 403);
  assert.equal(result.body.includes(KEY), false);
  assert.equal(fetch.calls.length, 1);
  assert.equal(new URL(fetch.calls[0].url).searchParams.get("key"), KEY);
});

test("Google calls carry the key in a header and the transit field mask", async () => {
  const fetch = fakeFetch();
  await routeTrip({ data: trip({ provider: "google", mode: "TRANSIT" }), db: new FakeFirestore(), keys, fetchImpl: fetch.impl, now: NOW });
  const { url, init } = fetch.calls[0];
  assert.equal(url, "https://routes.googleapis.com/directions/v2:computeRoutes");
  assert.equal(init.headers["X-Goog-Api-Key"], KEY);
  assert.match(init.headers["X-Goog-FieldMask"], /transitDetails/);
});

test("each install gets a daily ceiling that resets the next UTC day", async () => {
  const db = new FakeFirestore();
  const fetch = fakeFetch();
  for (let i = 0; i < DAILY_CALLS_PER_INSTALL; i += 1) {
    await routeTrip({ data: trip(), db, keys, fetchImpl: fetch.impl, now: NOW });
  }
  await assert.rejects(
    routeTrip({ data: trip(), db, keys, fetchImpl: fetch.impl, now: NOW }),
    { code: "resource-exhausted" },
  );
  assert.equal(fetch.calls.length, DAILY_CALLS_PER_INSTALL);
  await routeTrip({ data: trip(), db, keys, fetchImpl: fetch.impl, now: NOW + 86_400_000 });
  await routeTrip({ data: trip({ installId: "another-install" }), db, keys, fetchImpl: fetch.impl, now: NOW });
});

test("rotating install ids doesn't escape the per-network and per-provider ceilings", async () => {
  const db = new FakeFirestore();
  const fetch = fakeFetch();
  const install = (i) => `rotated-${String(i).padStart(4, "0")}`;
  for (let i = 0; i < HOURLY_CALLS_PER_NETWORK; i += 1) {
    await routeTrip({ data: trip({ installId: install(i) }), db, keys, fetchImpl: fetch.impl, network: "v4:203.0.113.9", now: NOW });
  }
  await assert.rejects(
    routeTrip({ data: trip({ installId: install(9999) }), db, keys, fetchImpl: fetch.impl, network: "v4:203.0.113.9", now: NOW }),
    { code: "resource-exhausted" },
  );
  assert.equal(fetch.calls.length, HOURLY_CALLS_PER_NETWORK);
  // Another network, or the same one an hour later, still gets through.
  await routeTrip({ data: trip({ installId: install(9999) }), db, keys, fetchImpl: fetch.impl, network: "v4:198.51.100.1", now: NOW });
  await routeTrip({ data: trip({ installId: install(9998) }), db, keys, fetchImpl: fetch.impl, network: "v4:203.0.113.9", now: NOW + 3_600_000 });
  // The network is stored only as a hash.
  assert.ok(![...db.documents.keys()].some((path) => path.includes("203.0.113.9")));
  assert.ok(!JSON.stringify([...db.documents.values()]).includes("203.0.113.9"));

  // Everyone together stays under the provider's daily ceiling; a refused call counts nowhere.
  const google = trip({ provider: "google" });
  db.documents.set(`travelRouteUsage/~provider.google.2026-10-13`, { count: DAILY_CALLS_PER_PROVIDER.google - 1 });
  await routeTrip({ data: { ...google, installId: "fresh-install-1" }, db, keys, fetchImpl: fetch.impl, network: "v4:192.0.2.1", now: NOW });
  const before = fetch.calls.length;
  await assert.rejects(
    routeTrip({ data: { ...google, installId: "fresh-install-2" }, db, keys, fetchImpl: fetch.impl, network: "v4:192.0.2.2", now: NOW }),
    { code: "resource-exhausted" },
  );
  assert.equal(fetch.calls.length, before);
  assert.equal(db.documents.has("travelRouteUsage/fresh-install-2"), false);
  // TomTom has its own ceiling, and the next UTC day starts over.
  await routeTrip({ data: { ...trip(), installId: "fresh-install-3" }, db, keys, fetchImpl: fetch.impl, network: "v4:192.0.2.3", now: NOW });
  await routeTrip({ data: { ...google, installId: "fresh-install-4" }, db, keys, fetchImpl: fetch.impl, network: "v4:192.0.2.4", now: NOW + 86_400_000 });
  assert.ok(DAILY_CALLS_PER_PROVIDER.google < 1500, "below the Routes API project quota");
});

test("a missing key or unreachable provider is refused without leaking details", async () => {
  await assert.rejects(
    routeTrip({ data: trip(), db: new FakeFirestore(), keys: { tomtom: () => "", google: () => KEY }, now: NOW }),
    { code: "failed-precondition" },
  );
  const warnings = [];
  await assert.rejects(
    routeTrip({
      data: trip(),
      db: new FakeFirestore(),
      keys,
      fetchImpl: async (url) => { throw new TypeError(`fetch failed ${url}`); },
      logger: { warn: (...args) => warnings.push(JSON.stringify(args)) },
      now: NOW,
    }),
    { code: "unavailable" },
  );
  assert.equal(warnings.some((line) => line.includes(KEY)), false);
});

test("a bike stays on typical speeds even when traffic is requested", () => {
  const url = tomTomUrl(parseRouteRequest(trip({ mode: "BICYCLE", routingPreference: "TRAFFIC_AWARE" }), NOW), KEY, NOW);
  assert.equal(url.searchParams.get("traffic"), "false");
  assert.equal(url.searchParams.get("computeTravelTimeFor"), null);
});

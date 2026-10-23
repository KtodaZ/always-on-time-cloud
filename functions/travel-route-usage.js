"use strict";

// Anonymous daily totals for the route proxy, for the studio dashboard: travelRouteDaily/{yyyy-mm-dd}
// (UTC) holds counters only, never an install id, network, coordinates, address or key.
//
//   installsActive                      installs whose first accepted call of the day this was
//   requests.{tomtom,google}.{mode}     provider fetches made (drive, transit, bicycle, walk)
//   sku.{tomtom_routing,google_routes_essentials,google_routes_pro}
//                                       the same fetches by billing SKU (an upper bound on billed)
//   outcomes.{provider}.{ok,http4xx,http429,http5xx,unreachable}
//   refused.{invalid,allowance,not_configured}
//                                       calls turned away before any provider fetch
//
// The totals are best-effort: a counter write that fails or outlasts WRITE_TIMEOUT_MS is dropped
// rather than retried, so a day can undercount; it is never awaited past that bound and never
// changes the route reply. Refusals cost no Firestore write of their own most of the time: they
// are held in memory and go out with the instance's next write, or alone at most once a minute.

const SCHEMA_VERSION = 1;
const WRITE_TIMEOUT_MS = 2_000;
const REFUSAL_FLUSH_MS = 60_000;
const MODES = { DRIVE: "drive", TRANSIT: "transit", BICYCLE: "bicycle", WALK: "walk" };
const REFUSALS = new Set(["invalid", "allowance", "not_configured"]);

const day = (now) => new Date(now).toISOString().slice(0, 10);

/** Google bills Compute Routes Pro for traffic-aware routing (driving only here), Essentials otherwise. */
function routeSku(provider, mode, routingPreference) {
  if (provider === "tomtom") return "tomtom_routing";
  return mode === "DRIVE" && routingPreference === "TRAFFIC_AWARE" ? "google_routes_pro" : "google_routes_essentials";
}

/** The outcome bucket for a provider status; null means the provider was never reached. */
function outcomeFor(status) {
  if (status === null || status === undefined) return "unreachable";
  if (status >= 200 && status < 300) return "ok";
  if (status === 429) return "http429";
  if (status >= 400 && status < 500) return "http4xx";
  // fetch follows redirects, so anything else is a provider-side failure.
  return "http5xx";
}

/**
 * Turns one routed call into counter paths. [event] is what routeTrip learned: `refused`, or
 * `firstToday` plus `fetch` ({ provider, mode, routingPreference, status }) once it reached one.
 */
function countsFor(event) {
  const counts = {};
  if (REFUSALS.has(event.refused)) counts[`refused.${event.refused}`] = 1;
  if (event.firstToday) counts.installsActive = 1;
  const fetch = event.fetch;
  if (fetch && (fetch.provider === "tomtom" || fetch.provider === "google") && MODES[fetch.mode]) {
    counts[`requests.${fetch.provider}.${MODES[fetch.mode]}`] = 1;
    counts[`sku.${routeSku(fetch.provider, fetch.mode, fetch.routingPreference)}`] = 1;
    counts[`outcomes.${fetch.provider}.${outcomeFor(fetch.status)}`] = 1;
  }
  return counts;
}

function nest(counts, increment) {
  const out = {};
  for (const [path, amount] of Object.entries(counts)) {
    const parts = path.split(".");
    let node = out;
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)] = increment(amount);
  }
  return out;
}

function add(target, counts) {
  for (const [path, amount] of Object.entries(counts)) target[path] = (target[path] ?? 0) + amount;
}

/**
 * `record(event, now)` counts one routed call. It always resolves, within about
 * [writeTimeoutMs], and never throws. [increment] is FieldValue.increment (injected for tests).
 */
function createRouteMetrics({
  db,
  increment,
  logger,
  clock = Date.now,
  writeTimeoutMs = WRITE_TIMEOUT_MS,
  refusalFlushMs = REFUSAL_FLUSH_MS,
}) {
  // Refusal counts not yet written, by UTC day.
  let held = new Map();
  let lastWriteAt = -Infinity;

  async function write(date, counts) {
    const ref = db.collection("travelRouteDaily").doc(date);
    let timer;
    const pending = Promise.resolve().then(() => ref.set({ schemaVersion: SCHEMA_VERSION, ...nest(counts, increment) }, { merge: true }));
    // A write that times out may still land later; it is never retried, so it can't count twice.
    pending.catch(() => {});
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, writeTimeoutMs, "timeout"); });
    try {
      if (await Promise.race([pending.then(() => "ok"), timeout]) === "timeout") {
        logger?.warn?.("Route metrics write timed out");
      }
    } catch (error) {
      logger?.warn?.("Route metrics write failed", { name: error?.name });
    } finally {
      clearTimeout(timer);
    }
  }

  return async function record(event, now = clock()) {
    try {
      const counts = countsFor(event ?? {});
      const date = day(now);
      const refusalOnly = Object.keys(counts).every((path) => path.startsWith("refused."));
      if (refusalOnly) {
        if (Object.keys(counts).length === 0) return;
        if (!held.has(date)) held.set(date, {});
        add(held.get(date), counts);
        if (clock() - lastWriteAt < refusalFlushMs) return;
      }
      const batch = held;
      held = new Map();
      if (!refusalOnly) add(batch.get(date) ?? batch.set(date, {}).get(date), counts);
      lastWriteAt = clock();
      await Promise.all([...batch].map(([key, value]) => write(key, value)));
    } catch (error) {
      logger?.warn?.("Route metrics failed", { name: error?.name });
    }
  };
}

module.exports = { SCHEMA_VERSION, countsFor, createRouteMetrics, outcomeFor, routeSku };

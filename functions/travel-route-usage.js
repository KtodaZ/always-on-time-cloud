"use strict";

const { createHash } = require("node:crypto");

// Anonymous daily totals for the route proxy, for the studio dashboard: travelRouteDaily/{yyyy-mm-dd}
// (UTC) holds counters only, never an install id, network, coordinates, address or key.
//
//   installsActive                      installs whose first accepted call of the day this was
//   requests.{tomtom,google}.{mode}     provider fetches made (drive, transit, bicycle, walk)
//   sku.{tomtom_routing,google_routes_essentials,google_routes_pro}
//                                       the same fetches by billing SKU (an upper bound on billed)
//   routes.{live,basic,transit}         the same fetches by kind of route (see routeKind)
//   outcomes.{provider}.{ok,http4xx,http429,http5xx,unreachable}
//   refused.{invalid,allowance,not_configured}
//                                       calls turned away before any provider fetch
//
// The totals are best-effort: a counter write that fails or outlasts WRITE_TIMEOUT_MS is dropped
// rather than retried, so a day can undercount; it is never awaited past that bound and never
// changes the route reply. Refusals cost no Firestore write of their own most of the time: they
// are held in memory and go out with the instance's next write, or alone at most once a minute.
//
// Per-phone history, to see how much routing one phone uses over time, for pricing and limits:
// travelRouteInstallDaily/{yyyy-mm-dd}_{phone} holds one phone's provider fetches for a UTC day.
// `phone` is a one-way hash of the install id, and the document has only that, the day and these
// counters, never a network, coordinates, address or key. A Firestore TTL policy on expiresAt
// deletes it after PHONE_HISTORY_DAYS.
//
//   calls                               provider fetches made
//   routes.{live,basic,transit}         the same fetches by kind of route
//   providers.{tomtom,google}           the same fetches by provider
//
// Only fetches are recorded here. A refused call writes nothing, so nobody can buy Firestore
// writes past the install's daily allowance. A phone at its allowance shows up as a full day.

const SCHEMA_VERSION = 1;
const WRITE_TIMEOUT_MS = 2_000;
const REFUSAL_FLUSH_MS = 60_000;
const MODES = { DRIVE: "drive", TRANSIT: "transit", BICYCLE: "bicycle", WALK: "walk" };
const REFUSALS = new Set(["invalid", "allowance", "not_configured"]);
const DAY_MS = 24 * 60 * 60 * 1000;
const PHONE_HISTORY_DAYS = 90;

const day = (now) => new Date(now).toISOString().slice(0, 10);

/** Google bills Compute Routes Pro for traffic-aware routing (driving only here), Essentials otherwise. */
function routeSku(provider, mode, routingPreference) {
  if (provider === "tomtom") return "tomtom_routing";
  return mode === "DRIVE" && routingPreference === "TRAFFIC_AWARE" ? "google_routes_pro" : "google_routes_essentials";
}

/** Live traffic is the Plus benefit: traffic-aware drives. Transit is Google-only and scheduled. */
function routeKind(mode, routingPreference) {
  if (mode === "TRANSIT") return "transit";
  return mode === "DRIVE" && routingPreference === "TRAFFIC_AWARE" ? "live" : "basic";
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

const isCountedFetch = (fetch) =>
  Boolean(fetch) && (fetch.provider === "tomtom" || fetch.provider === "google") && Boolean(MODES[fetch.mode]);

/** The stable, one-way id a phone's history is kept under. */
const phoneKey = (installId) =>
  createHash("sha256").update(`travelRouteInstallDaily:${installId}`, "utf8").digest("hex").slice(0, 32);

/** The history write for one routed call, or null when it reached no provider. */
function phoneDayFor(event, now, increment) {
  const fetch = event.fetch;
  if (!isCountedFetch(fetch) || typeof event.installId !== "string") return null;
  const date = day(now);
  const phone = phoneKey(event.installId);
  return {
    id: `${date}_${phone}`,
    data: {
      schemaVersion: SCHEMA_VERSION,
      day: date,
      phone,
      expiresAt: new Date(now + PHONE_HISTORY_DAYS * DAY_MS),
      ...nest({
        calls: 1,
        [`routes.${routeKind(fetch.mode, fetch.routingPreference)}`]: 1,
        [`providers.${fetch.provider}`]: 1,
      }, increment),
    },
  };
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
  if (isCountedFetch(fetch)) {
    counts[`requests.${fetch.provider}.${MODES[fetch.mode]}`] = 1;
    counts[`sku.${routeSku(fetch.provider, fetch.mode, fetch.routingPreference)}`] = 1;
    counts[`routes.${routeKind(fetch.mode, fetch.routingPreference)}`] = 1;
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

  async function write(collection, id, data) {
    let timer;
    const pending = Promise.resolve().then(() => db.collection(collection).doc(id).set(data, { merge: true }));
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
      const writes = [...batch].map(([key, value]) =>
        write("travelRouteDaily", key, { schemaVersion: SCHEMA_VERSION, ...nest(value, increment) }));
      const phoneDay = phoneDayFor(event ?? {}, now, increment);
      if (phoneDay) writes.push(write("travelRouteInstallDaily", phoneDay.id, phoneDay.data));
      await Promise.all(writes);
    } catch (error) {
      logger?.warn?.("Route metrics failed", { name: error?.name });
    }
  };
}

module.exports = { PHONE_HISTORY_DAYS, SCHEMA_VERSION, countsFor, createRouteMetrics, outcomeFor, phoneKey, routeKind, routeSku };

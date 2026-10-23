"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { FakeFirestore } = require("../testing/fake-firestore");
const { routeTrip } = require("../travel-route");
const { countsFor, createRouteMetrics, outcomeFor, routeSku } = require("../travel-route-usage");

const NOW = Date.parse("2026-10-13T15:00:00Z");
const KEY = "server-key-123";
const keys = { tomtom: () => KEY, google: () => KEY };
const increment = (amount) => ({ __increment: amount });

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

function fakeFetch(status = 200) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    return { ok: status >= 200 && status < 300, status, text: async () => '{"routes":[]}' };
  };
  return { calls, impl };
}

/** A route proxy whose metrics write to [db] (refusals flushed at once unless told otherwise). */
function setup({ db = new FakeFirestore(), status = 200, metricsDb = db, ...options } = {}) {
  const fetch = fakeFetch(status);
  const warnings = [];
  const logger = { warn: (...args) => warnings.push(JSON.stringify(args)) };
  const metrics = createRouteMetrics({ db: metricsDb, increment, logger, refusalFlushMs: 0, ...options });
  const route = (overrides = {}, at = NOW, extra = {}) => routeTrip({
    data: trip(overrides), db, keys, fetchImpl: fetch.impl, metrics, logger, network: "v4:203.0.113.9", now: at, ...extra,
  });
  const daily = (date = "2026-10-13") => db.documents.get(`travelRouteDaily/${date}`);
  return { db, fetch, metrics, route, daily, warnings };
}

test("an install counts as active once a day, even across repeated and concurrent calls", async () => {
  const { route, daily } = setup();
  await route();
  await route();
  await Promise.all([route({ installId: "install-two" }), route({ installId: "install-two" })]);
  const totals = daily();
  assert.equal(totals.installsActive, 2);
  assert.equal(totals.requests.tomtom.drive, 4);
  assert.equal(totals.schemaVersion, 1);
});

test("the day is the UTC day, for active installs and requests alike", async () => {
  const { route, daily } = setup();
  const lastSecond = Date.parse("2026-10-13T23:59:59Z");
  await route({ arriveByMillis: lastSecond + 3_600_000 }, lastSecond);
  await route({ arriveByMillis: lastSecond + 3_600_000 }, lastSecond + 2_000);
  assert.equal(daily("2026-10-13").installsActive, 1);
  assert.equal(daily("2026-10-14").installsActive, 1);
  assert.equal(daily("2026-10-13").requests.tomtom.drive, 1);
  assert.equal(daily("2026-10-14").requests.tomtom.drive, 1);
});

test("each provider fetch counts once, by provider, mode and billing SKU", async () => {
  const { route, daily, fetch } = setup();
  await route();
  await route({ mode: "WALK" });
  await route({ provider: "google", mode: "TRANSIT" });
  await route({ provider: "google", routingPreference: "TRAFFIC_AWARE" });
  await route({ provider: "google", routingPreference: "TRAFFIC_UNAWARE" });
  await route({ provider: "google", mode: "BICYCLE", routingPreference: "TRAFFIC_AWARE" });
  const totals = daily();
  assert.equal(fetch.calls.length, 6);
  assert.deepEqual(totals.requests, { tomtom: { drive: 1, walk: 1 }, google: { transit: 1, drive: 2, bicycle: 1 } });
  assert.deepEqual(totals.sku, { tomtom_routing: 2, google_routes_essentials: 3, google_routes_pro: 1 });
  assert.deepEqual(totals.outcomes, { tomtom: { ok: 2 }, google: { ok: 4 } });
});

test("Google is Pro only for traffic-aware drives", () => {
  assert.equal(routeSku("google", "DRIVE", "TRAFFIC_AWARE"), "google_routes_pro");
  assert.equal(routeSku("google", "DRIVE", "TRAFFIC_UNAWARE"), "google_routes_essentials");
  assert.equal(routeSku("google", "TRANSIT", "TRAFFIC_AWARE"), "google_routes_essentials");
  assert.equal(routeSku("google", "WALK", "TRAFFIC_AWARE"), "google_routes_essentials");
  assert.equal(routeSku("tomtom", "DRIVE", "TRAFFIC_AWARE"), "tomtom_routing");
});

test("refused calls are counted by reason and never as requests or active installs", async () => {
  const db = new FakeFirestore();
  const { route, daily, fetch } = setup({ db });
  await assert.rejects(route({ mode: "FLY" }), { code: "invalid-argument" });
  await assert.rejects(
    routeTrip({ data: trip(), db, keys: { tomtom: () => "", google: () => KEY }, fetchImpl: fetch.impl, metrics: setup({ db }).metrics, now: NOW }),
    { code: "failed-precondition" },
  );
  db.documents.set("travelRouteUsage/~provider.tomtom.2026-10-13", { count: 1_000_000 });
  await assert.rejects(route(), { code: "resource-exhausted" });
  const totals = daily();
  assert.equal(fetch.calls.length, 0);
  assert.deepEqual(totals.refused, { invalid: 1, not_configured: 1, allowance: 1 });
  assert.equal(totals.requests, undefined);
  assert.equal(totals.sku, undefined);
  assert.equal(totals.installsActive, undefined);
});

test("refusals wait in memory for the next write, or go out alone at most once a minute", async () => {
  let clock = NOW;
  const { route, daily, db } = setup({ clock: () => clock, refusalFlushMs: 60_000 });
  await route();
  const writes = db.writes;
  for (let i = 0; i < 5; i += 1) await assert.rejects(route({ mode: "FLY" }), { code: "invalid-argument" });
  assert.equal(db.writes, writes, "refusals within a minute of a write cost no write");
  assert.equal(daily().refused, undefined);
  await route({ installId: "install-two" });
  assert.equal(daily().refused.invalid, 5);
  clock += 61_000;
  await assert.rejects(route({ mode: "FLY" }), { code: "invalid-argument" });
  assert.equal(daily().refused.invalid, 6);
});

test("provider failures are counted by outcome", async () => {
  for (const [status, bucket] of [[403, "http4xx"], [429, "http429"], [503, "http5xx"]]) {
    const { route, daily } = setup({ status });
    const result = await route({ provider: "google" });
    assert.equal(result.status, status);
    assert.deepEqual(daily().outcomes, { google: { [bucket]: 1 } });
    assert.equal(daily().requests.google.drive, 1);
  }
  const db = new FakeFirestore();
  const metrics = createRouteMetrics({ db, increment });
  await assert.rejects(
    routeTrip({ data: trip(), db, keys, metrics, now: NOW, fetchImpl: async () => { throw new TypeError("fetch failed"); } }),
    { code: "unavailable" },
  );
  const totals = db.documents.get("travelRouteDaily/2026-10-13");
  assert.deepEqual(totals.outcomes, { tomtom: { unreachable: 1 } });
  assert.equal(totals.requests.tomtom.drive, 1);
  assert.equal(outcomeFor(204), "ok");
});

test("a broken, failing or hung counter never changes the route's reply", async () => {
  const hanging = (db) => ({ collection: (name) => name === "travelRouteDaily"
    ? { doc: () => ({ set: () => new Promise(() => {}) }) }
    : db.collection(name) });
  const failing = () => ({ collection: () => { throw new Error("firestore down"); } });
  const rejecting = () => ({ collection: () => ({ doc: () => ({ set: async () => { throw new Error("quota"); } }) }) });
  for (const broken of [hanging, failing, rejecting]) {
    const db = new FakeFirestore();
    const { route, warnings } = setup({ db, metricsDb: broken(db), writeTimeoutMs: 20 });
    const started = Date.now();
    assert.equal((await route()).status, 200);
    await assert.rejects(route({ mode: "FLY" }), { code: "invalid-argument" });
    assert.ok(Date.now() - started < 1_000, "bounded by the write timeout");
    assert.ok(warnings.some((line) => line.includes("Route metrics")));
    // The allowance still counted the accepted call.
    assert.equal(db.documents.get("travelRouteUsage/install-abc123").count, 1);
  }
  const result = await routeTrip({
    data: trip(), db: new FakeFirestore(), keys, fetchImpl: fakeFetch().impl, now: NOW,
    metrics: async () => { throw new Error("misbehaving metrics"); },
  });
  assert.equal(result.status, 200);
});

test("daily totals hold counters only: no install id, network, place or key", async () => {
  const { route, daily } = setup();
  await route();
  await route({ provider: "google", mode: "TRANSIT" });
  await assert.rejects(route({ installId: "x" }), { code: "invalid-argument" });
  const text = JSON.stringify(daily());
  for (const secret of ["install-abc123", "203.0.113.9", "37.79", "SFO", KEY]) assert.equal(text.includes(secret), false, secret);
  const numbersOnly = (value) => Object.values(value).every((field) => typeof field === "number" || numbersOnly(field));
  assert.ok(numbersOnly(daily()));
});

test("an event with nothing to count writes nothing", async () => {
  const db = new FakeFirestore();
  await createRouteMetrics({ db, increment })({}, NOW);
  assert.equal(db.writes, 0);
  assert.deepEqual(countsFor({ fetch: { provider: "here", mode: "DRIVE" } }), {});
});

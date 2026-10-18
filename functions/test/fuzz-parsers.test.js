"use strict";

// Property-based fuzzing of the parsers that take untrusted input: assistant record payloads (from
// assistants and phones) and travel route requests (from phones). Each must either accept the input
// or reject it with its own error type, never crash, and canonical payloads must be stable.

const assert = require("node:assert/strict");
const test = require("node:test");
const fc = require("fast-check");

const {
  PREFERENCE_BOOLEANS, PREFERENCE_INTEGERS, PREFERENCE_LONGS, PREFERENCE_STRINGS, RecordError,
  canonicalPayload, encodePayload, parseGoogleEventId, samePayload, validatePayload,
} = require("../assistant-records");
const { RouteRequestError, parseRouteRequest } = require("../travel-route");

const RUNS = { numRuns: 500 };
const HEX = fc.stringMatching(/^[a-f0-9]{64}$/);
const PREFERENCE_IDS = [
  ...PREFERENCE_BOOLEANS, ...PREFERENCE_INTEGERS.keys(), ...PREFERENCE_STRINGS.keys(), ...PREFERENCE_LONGS.keys(),
].map((name) => `p_${name}`);

const recordId = fc.oneof(
  fc.constantFrom(...PREFERENCE_IDS),
  fc.tuple(fc.constantFrom("c_", "s_", "e_"), HEX).map(([prefix, hex]) => prefix + hex),
  fc.string(),
);

// Values near the real shapes (so validation passes often) mixed with arbitrary JSON.
const leadTimes = fc.array(fc.integer({ min: -2000, max: 11000 }), { maxLength: 24 });
const override = fc.record({
  leadTimes,
  enabled: fc.oneof(fc.boolean(), fc.jsonValue()),
  volume: fc.integer({ min: -5, max: 105 }),
  vibrationPattern: fc.string({ maxLength: 120 }),
  ignoreAllDay: fc.boolean(),
  rsvpFilter: fc.string({ maxLength: 120 }),
  addedLeadTimes: leadTimes,
  travelLeadTimes: fc.array(fc.integer({ min: -5, max: 200 }), { maxLength: 6 }),
  ringThroughDnd: fc.oneof(fc.boolean(), fc.constant(null)),
  __proto__: fc.jsonValue(),
  newerAppField: fc.jsonValue(),
}, { requiredKeys: [] });
const value = fc.oneof(
  override,
  fc.record({ selected: fc.oneof(fc.boolean(), fc.constant(null), fc.jsonValue()), overrides: override }, { requiredKeys: [] }),
  fc.boolean(), fc.integer({ min: -10, max: 100000 }), fc.string({ maxLength: 600 }), fc.constant(null),
  fc.jsonValue(),
);
const payload = fc.oneof(value.map((item) => JSON.stringify(item) ?? "null"), fc.json(), fc.string());

test("payload validation accepts or throws RecordError for any input", () => {
  fc.assert(fc.property(recordId, payload, (id, text) => {
    try {
      validatePayload(id, text);
    } catch (error) {
      assert.ok(error instanceof RecordError, `unexpected ${error}`);
    }
    assert.equal(typeof canonicalPayload(id, text), "string");
  }), RUNS);
});

test("encoded payloads validate and are already canonical", () => {
  fc.assert(fc.property(recordId, value, (id, item) => {
    let encoded;
    try {
      encoded = encodePayload(id, item);
    } catch (error) {
      assert.ok(error instanceof RecordError, `unexpected ${error}`);
      return;
    }
    const parsed = validatePayload(id, encoded);
    assert.equal(encodePayload(id, parsed), encoded);
    assert.equal(canonicalPayload(id, encoded), encoded);
    assert.ok(samePayload(id, JSON.stringify(item), encoded));
  }), RUNS);
});

test("Google event ids parse without throwing for any non-empty text", () => {
  fc.assert(fc.property(fc.oneof(fc.string({ minLength: 1 }), fc.stringMatching(/^[a-z0-9]{1,20}_\d{8}(T\d{6}Z)?$/)), (id) => {
    let parsed;
    try {
      parsed = parseGoogleEventId(id);
    } catch (error) {
      assert.ok(error instanceof RecordError, `unexpected ${error}`);
      return;
    }
    assert.equal(typeof parsed.seriesId, "string");
    assert.ok(parsed.originalStartMillis === null || Number.isSafeInteger(parsed.originalStartMillis));
  }), RUNS);
});

test("route requests are accepted only in the documented shape", () => {
  const now = Date.UTC(2026, 9, 17);
  const coordinate = fc.oneof(
    fc.record({ latitude: fc.double({ min: -100, max: 100 }), longitude: fc.double({ min: -200, max: 200 }) }),
    fc.anything(),
  );
  const time = fc.oneof(fc.integer({ min: now - 2 * 86400000, max: now + 100 * 86400000 }), fc.double(), fc.anything());
  const request = fc.oneof(
    fc.record({
      provider: fc.constantFrom("tomtom", "google", "other"),
      installId: fc.oneof(fc.stringMatching(/^[A-Za-z0-9_-]{6,70}$/), fc.anything()),
      mode: fc.constantFrom("DRIVE", "TRANSIT", "BICYCLE", "WALK", "FLY"),
      routingPreference: fc.constantFrom("TRAFFIC_UNAWARE", "TRAFFIC_AWARE", "BEST", undefined),
      origin: coordinate,
      destinationCoordinate: coordinate,
      destination: fc.oneof(fc.string({ maxLength: 320 }), fc.anything()),
      arriveByMillis: time,
      departureAtMillis: fc.oneof(time, fc.constant(undefined)),
      extra: fc.anything(),
    }, { requiredKeys: [] }),
    fc.anything(),
  );
  fc.assert(fc.property(request, (data) => {
    let parsed;
    try {
      parsed = parseRouteRequest(data, now);
    } catch (error) {
      assert.ok(error instanceof RouteRequestError, `unexpected ${error}`);
      return;
    }
    assert.deepEqual(Object.keys(parsed).sort(), [
      "arriveByMillis", "departureAtMillis", "destination", "installId", "mode", "origin", "provider", "routingPreference",
    ]);
    for (const point of [parsed.origin, parsed.provider === "tomtom" ? parsed.destination : parsed.origin]) {
      assert.ok(Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180);
    }
    if (parsed.provider === "google") assert.ok(typeof parsed.destination === "string" && parsed.destination.length <= 300);
  }), RUNS);
});

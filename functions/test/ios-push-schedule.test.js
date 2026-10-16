"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  COALESCE_MS,
  canSendNow,
  computeNextWakeAtMs,
  duePrecheckStages,
  failureBackoffMs,
  isHeartbeatDue,
  isRenewalDue,
  isWithinActiveHours,
  nextActiveTime,
  planPush,
  renewRetryAtMs,
} = require("../ios-push-schedule");

const MINUTE = 60 * 1000;
// 09:00 in Los Angeles (PDT, UTC-7).
const NOW = Date.parse("2026-10-07T16:00:00.000Z");
const HEARTBEAT = { intervalMinutes: 20, activeHours: { start: "07:00", end: "22:00" }, timeZone: "America/Los_Angeles" };

function install(overrides = {}) {
  return {
    enabled: true,
    heartbeat: HEARTBEAT,
    createdAtMs: NOW - 60 * MINUTE,
    lastPushAtMs: null,
    pushClaimedAtMs: null,
    retryAfterMs: null,
    pendingChangeAtMs: null,
    alarms: [],
    ...overrides,
  };
}

test("active hours include start, exclude end, and support ranges across midnight", () => {
  const day = { ...HEARTBEAT, activeHours: { start: "09:00", end: "17:00" } };
  assert.equal(isWithinActiveHours(Date.parse("2026-10-07T16:00:00Z"), day), true); // 09:00
  assert.equal(isWithinActiveHours(Date.parse("2026-10-07T15:59:00Z"), day), false); // 08:59
  assert.equal(isWithinActiveHours(Date.parse("2026-10-08T00:00:00Z"), day), false); // 17:00

  const night = { ...HEARTBEAT, activeHours: { start: "22:00", end: "06:00" } };
  assert.equal(isWithinActiveHours(Date.parse("2026-10-08T05:30:00Z"), night), true); // 22:30
  assert.equal(isWithinActiveHours(Date.parse("2026-10-08T12:59:00Z"), night), true); // 05:59
  assert.equal(isWithinActiveHours(Date.parse("2026-10-08T13:00:00Z"), night), false); // 06:00
  assert.equal(isWithinActiveHours(Date.parse("2026-10-07T20:00:00Z"), night), false); // 13:00
});

test("active hours follow the install's time zone, not UTC", () => {
  const tokyo = { ...HEARTBEAT, timeZone: "Asia/Tokyo" };
  // 16:00Z is 01:00 the next day in Tokyo.
  assert.equal(isWithinActiveHours(NOW, tokyo), false);
  assert.equal(isWithinActiveHours(NOW, HEARTBEAT), true);
});

test("nextActiveTime finds the next local start, including across a DST change", () => {
  const lateEvening = Date.parse("2026-10-08T05:30:00Z"); // 22:30 PDT
  assert.equal(nextActiveTime(lateEvening, HEARTBEAT), Date.parse("2026-10-08T14:00:00Z")); // 07:00 PDT
  assert.equal(nextActiveTime(NOW, HEARTBEAT), NOW);

  // US DST ends 2026-11-01 at 02:00 PDT: 07:00 that morning is PST (UTC-8).
  const beforeFallBack = Date.parse("2026-11-01T06:00:00Z"); // 23:00 PDT Oct 31
  const next = nextActiveTime(beforeFallBack, HEARTBEAT);
  assert.equal(next, Date.parse("2026-11-01T15:00:00Z"));
  assert.equal(isWithinActiveHours(next, HEARTBEAT), true);
  assert.equal(isWithinActiveHours(next - MINUTE, HEARTBEAT), false);
});

test("nextActiveTime finds the first active minute across spring-forward DST", () => {
  // US DST starts 2026-03-08 at 02:00 local. From 22:00 PST on Mar 7, 07:00 PDT is 14:00Z.
  assert.equal(nextActiveTime(Date.parse("2026-03-08T06:00:00Z"), HEARTBEAT), Date.parse("2026-03-08T14:00:00Z"));
  // A start inside the skipped hour begins at the first minute that exists after it (03:00 EDT).
  const newYork = { ...HEARTBEAT, activeHours: { start: "02:30", end: "22:00" }, timeZone: "America/New_York" };
  assert.equal(nextActiveTime(Date.parse("2026-03-08T04:00:00Z"), newYork), Date.parse("2026-03-08T07:00:00Z"));
});

test("heartbeat is due after the interval since the last accepted push, only in active hours", () => {
  assert.equal(isHeartbeatDue(install({ lastPushAtMs: NOW - 19 * MINUTE }), NOW), false);
  assert.equal(isHeartbeatDue(install({ lastPushAtMs: NOW - 20 * MINUTE }), NOW), true);
  // Any push kind resets the timer, so a recent change push skips the heartbeat.
  assert.equal(isHeartbeatDue(install({ lastPushAtMs: NOW - 5 * MINUTE }), NOW), false);
  // A new install is fresh at registration time.
  assert.equal(isHeartbeatDue(install({ createdAtMs: NOW - 10 * MINUTE }), NOW), false);
  const night = Date.parse("2026-10-08T07:00:00Z"); // 00:00 PDT
  assert.equal(isHeartbeatDue(install({ lastPushAtMs: night - 60 * MINUTE }), night), false);
});

test("precheck stages are due from T-20 and T-8 for two minutes, once per trigger", () => {
  const trigger = NOW + 20 * MINUTE;
  const alarm = { key: "a", triggerAtMs: trigger, sent: {} };
  assert.deepEqual(duePrecheckStages([alarm], NOW - 1), []);
  assert.deepEqual(duePrecheckStages([alarm], NOW), [{ key: "a", stage: "t20" }]);
  assert.deepEqual(duePrecheckStages([alarm], NOW + 2 * MINUTE), [{ key: "a", stage: "t20" }]);
  assert.deepEqual(duePrecheckStages([alarm], NOW + 2 * MINUTE + 1), []);
  assert.deepEqual(duePrecheckStages([alarm], trigger - 8 * MINUTE), [{ key: "a", stage: "t8" }]);
  assert.deepEqual(duePrecheckStages([{ ...alarm, sent: { t20: NOW } }], NOW + MINUTE), []);
  assert.deepEqual(duePrecheckStages([{ ...alarm, triggerAtMs: NOW }], NOW), []);
});

test("canSendNow enforces two-minute coalescing, in-flight claims, and failure backoff", () => {
  assert.equal(canSendNow(install(), NOW), true);
  assert.equal(canSendNow(install({ enabled: false }), NOW), false);
  assert.equal(canSendNow(install({ lastPushAtMs: NOW - COALESCE_MS + 1 }), NOW), false);
  assert.equal(canSendNow(install({ lastPushAtMs: NOW - COALESCE_MS }), NOW), true);
  assert.equal(canSendNow(install({ pushClaimedAtMs: NOW - MINUTE }), NOW), false);
  assert.equal(canSendNow(install({ pushClaimedAtMs: NOW - 2 * MINUTE }), NOW), true);
  assert.equal(canSendNow(install({ retryAfterMs: NOW + 1 }), NOW), false);
});

test("planPush picks one kind by urgency: precheck, change, renew, heartbeat", () => {
  const dueAlarm = { key: "a", triggerAtMs: NOW + 8 * MINUTE, sent: {} };
  const renewal = { key: "sub", provider: "google", expiresAtMs: NOW + 60 * MINUTE, renewDueAtMs: NOW - 1 };
  const everything = install({
    lastPushAtMs: NOW - 30 * MINUTE,
    pendingChangeAtMs: NOW - MINUTE,
    pendingChangeProvider: "microsoft",
    alarms: [dueAlarm],
  });
  assert.deepEqual(planPush(everything, NOW, { renewals: [renewal] }), { kind: "precheck", renewalKeys: [] });
  assert.deepEqual(planPush({ ...everything, alarms: [] }, NOW, { renewals: [renewal] }),
    { kind: "change", provider: "microsoft", renewalKeys: [] });
  assert.deepEqual(planPush({ ...everything, alarms: [], pendingChangeAtMs: null }, NOW, { renewals: [renewal] }),
    { kind: "renew", provider: "google", renewalKeys: ["sub"] });
  assert.deepEqual(planPush({ ...everything, alarms: [], pendingChangeAtMs: null }, NOW),
    { kind: "heartbeat", renewalKeys: [] });
  assert.equal(planPush({ ...everything, lastPushAtMs: NOW - MINUTE }, NOW, { renewals: [renewal] }), null);
});

test("a due heartbeat becomes a precheck when a stage opens within the coalescing window", () => {
  const soon = { key: "a", triggerAtMs: NOW + 21 * MINUTE, sent: {} };
  assert.deepEqual(planPush(install({ lastPushAtMs: NOW - 30 * MINUTE, alarms: [soon] }), NOW), { kind: "precheck", renewalKeys: [] });
  const later = { ...soon, triggerAtMs: NOW + 23 * MINUTE };
  assert.deepEqual(planPush(install({ lastPushAtMs: NOW - 30 * MINUTE, alarms: [later] }), NOW), { kind: "heartbeat", renewalKeys: [] });
});

test("renew pushes omit the provider when renewals span providers", () => {
  const renewals = [
    { key: "g", provider: "google", expiresAtMs: NOW + MINUTE, renewDueAtMs: NOW },
    { key: "m", provider: "microsoft", expiresAtMs: NOW + MINUTE, renewDueAtMs: NOW },
  ];
  assert.deepEqual(planPush(install(), NOW, { renewals }), { kind: "renew", renewalKeys: ["g", "m"] });
});

test("computeNextWakeAtMs returns the earliest heartbeat, precheck, or pending change", () => {
  // Heartbeat interval from creation.
  assert.equal(computeNextWakeAtMs(install({ createdAtMs: NOW }), NOW), NOW + 20 * MINUTE);
  // Outside active hours, the heartbeat waits for the next local start.
  const night = Date.parse("2026-10-08T07:00:00Z");
  assert.equal(computeNextWakeAtMs(install({ createdAtMs: night }), night), Date.parse("2026-10-08T14:00:00Z"));
  // An upcoming precheck stage comes first, even at night.
  const alarm = { key: "a", triggerAtMs: night + 60 * MINUTE, sent: {} };
  assert.equal(computeNextWakeAtMs(install({ createdAtMs: night, alarms: [alarm] }), night), night + 40 * MINUTE);
  // Sent stages are skipped.
  assert.equal(
    computeNextWakeAtMs(install({ createdAtMs: night, alarms: [{ ...alarm, sent: { t20: night } }] }), night),
    night + 52 * MINUTE,
  );
  // A pending change is due immediately, but not before coalescing allows another push.
  assert.equal(computeNextWakeAtMs(install({ pendingChangeAtMs: NOW }), NOW), NOW);
  assert.equal(computeNextWakeAtMs(install({ pendingChangeAtMs: NOW, lastPushAtMs: NOW - 30 * 1000 }), NOW),
    NOW + 90 * 1000);
  assert.equal(computeNextWakeAtMs(install({ pendingChangeAtMs: NOW, retryAfterMs: NOW + 4 * MINUTE }), NOW),
    NOW + 4 * MINUTE);
  assert.equal(computeNextWakeAtMs(install({ enabled: false }), NOW), null);
});

test("renewal timing: due flag, retry before expiry, and failure backoff", () => {
  assert.equal(isRenewalDue({ expiresAtMs: NOW + 1, renewDueAtMs: NOW }, NOW), true);
  assert.equal(isRenewalDue({ expiresAtMs: NOW, renewDueAtMs: NOW }, NOW), false);
  assert.equal(isRenewalDue({ expiresAtMs: NOW + 1, renewDueAtMs: null }, NOW), false);
  // Past the recorded expiry only a lifecycle request is due (one prompt; see completePush).
  assert.equal(isRenewalDue({ expiresAtMs: NOW - 1, renewDueAtMs: NOW, renewalRequestedAtMs: NOW }, NOW), true);
  assert.equal(isRenewalDue({ expiresAtMs: NOW - 1, renewDueAtMs: NOW, renewalRequestedAtMs: null }, NOW), false);
  assert.equal(isRenewalDue({ expiresAtMs: NOW - 1, renewDueAtMs: null, renewalRequestedAtMs: NOW }, NOW), false);
  assert.equal(renewRetryAtMs(NOW, NOW + 24 * 60 * MINUTE), NOW + 6 * 60 * MINUTE);
  assert.equal(renewRetryAtMs(NOW, NOW + 60 * MINUTE), null);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(failureBackoffMs), [1, 2, 4, 8, 16, 30, 30].map((m) => m * MINUTE));
});

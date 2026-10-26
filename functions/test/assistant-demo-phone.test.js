"use strict";

// The review account's stand-in phone (assistant-demo-phone.js): how it resolves alarms, that only
// the configured demo account gets it, and that every tool completes against it.

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const http = require("node:http");
const test = require("node:test");

const { FakeFirestore } = require("../testing/fake-firestore");
const {
  CALENDARS, DEMO_DEVICE_ID, DEMO_DEVICE_NAME, SNAPSHOT_MAX_AGE_MS, buildDemoSnapshot, demoSeedValues, ensureDemoPhone, resetDemoAccount,
} = require("../assistant-demo-phone");
const { createMcpHandler, loadSdk } = require("../assistant-mcp");
const { createRecordingMessaging, sendToDevices } = require("../assistant-push");
const { encodePayload } = require("../assistant-records");
const { createUsage } = require("../assistant-usage");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// Monday, Oct 26, 2026, 8:00 AM in Los Angeles (PDT).
const MONDAY_8AM = Date.parse("2026-10-26T15:00:00Z");
const DEMO = "reviewer";
const WORK = CALENDARS.find((calendar) => calendar.name === "Work").key;
const PERSONAL = CALENDARS.find((calendar) => calendar.name === "Personal").key;

const seeded = () => Object.fromEntries(Object.entries(demoSeedValues()).map(([id, value]) => [id, JSON.parse(encodePayload(id, value))]));
const byTitle = (snapshot, title) => snapshot.events.filter((event) => event.title === title);
const leads = (event) => event.alarms.map((alarm) => [alarm.minutes, alarm.source, alarm.status]);

test("the demo week: two calendars, a recurring standup, and alarms from the app default, a series and a calendar", () => {
  const snapshot = buildDemoSnapshot(seeded(), MONDAY_8AM, 0);
  assert.equal(snapshot.device, DEMO_DEVICE_NAME);
  assert.equal(snapshot.timeZone, "America/Los_Angeles");
  assert.deepEqual(snapshot.calendars.map((calendar) => [calendar.name, calendar.watched, calendar.leadTimes, calendar.rsvpFilter, calendar.includeAllDay]), [
    ["Work", true, [10, 0], "not_declined", false],
    ["Personal", true, [5, 30], "not_declined", false],
  ]);
  const standups = byTitle(snapshot, "Team standup");
  assert.equal(standups.length, 5, "weekdays of the coming week");
  assert.equal(new Set(standups.map((event) => event.seriesKey)).size, 1);
  assert.equal(new Set(standups.map((event) => event.eventKey)).size, 5);
  assert.equal(standups[0].start, Date.parse("2026-10-26T16:30:00Z"));
  assert.deepEqual(leads(standups[0]), [[10, "app", "on"], [0, "app", "on"]]);
  assert.deepEqual(leads(byTitle(snapshot, "1:1 with Sam")[0]), [[15, "series", "on"], [5, "series", "on"]]);
  assert.deepEqual(leads(byTitle(snapshot, "Flight to Denver")[0]), [[30, "calendar", "on"], [5, "calendar", "on"]]);
  assert.ok(snapshot.events.length >= 10 && snapshot.events.length <= 15, `${snapshot.events.length} events`);
  // The default filters skip the declined invitation and the all-day birthday.
  assert.deepEqual(byTitle(snapshot, "Lunch and learn"), []);
  assert.deepEqual(byTitle(snapshot, "Sam's birthday"), []);
  assert.ok(snapshot.events.every((event) => event.start < MONDAY_8AM + 7 * 24 * HOUR && event.end > MONDAY_8AM));
  // Keys are stable across rebuilds an hour apart.
  const later = buildDemoSnapshot(seeded(), MONDAY_8AM + HOUR, 0);
  assert.equal(byTitle(later, "Design review: onboarding flow")[0].eventKey, byTitle(snapshot, "Design review: onboarding flow")[0].eventKey);
  assert.equal(byTitle(later, "Team standup")[0].eventKey, standups[0].eventKey);
});

test("lead times: occurrence over series over calendar over the app default; added lead times add; enabled false turns alarms off", () => {
  const base = buildDemoSnapshot({}, MONDAY_8AM, 0);
  const [standup, nextStandup] = byTitle(base, "Team standup");
  const values = {
    p_default_lead_times_csv: JSON.stringify([0, 20]),
    [WORK]: { overrides: { leadTimes: [7] } },
    [standup.seriesKey]: { leadTimes: [3], addedLeadTimes: [45] },
    [standup.eventKey]: { leadTimes: [1], enabled: true },
  };
  const snapshot = buildDemoSnapshot(values, MONDAY_8AM, 0);
  const [first, second] = byTitle(snapshot, "Team standup");
  assert.deepEqual(leads(first), [[45, "series", "on"], [1, "event", "on"]]);
  assert.deepEqual(leads(second), [[45, "series", "on"], [3, "series", "on"]]);
  assert.deepEqual(leads(byTitle(snapshot, "Team lunch")[0]), [[7, "calendar", "on"]]);
  assert.deepEqual(leads(byTitle(snapshot, "Dentist appointment")[0]), [[20, "app", "on"], [0, "app", "on"]]);
  assert.deepEqual(snapshot.calendars.find((calendar) => calendar.key === WORK).leadTimes, [7]);

  // Off at the series wins over the calendar; the occurrence's own enabled wins over the series.
  const off = buildDemoSnapshot({
    [standup.seriesKey]: { enabled: false },
    [nextStandup.eventKey]: { enabled: true },
    [PERSONAL]: { overrides: { enabled: false } },
  }, MONDAY_8AM, 0);
  const [offFirst, onSecond] = byTitle(off, "Team standup");
  assert.deepEqual(offFirst.alarms.map((alarm) => alarm.status), ["off", "off"]);
  assert.deepEqual(onSecond.alarms.map((alarm) => alarm.status), ["on", "on"]);
  assert.deepEqual(byTitle(off, "Flight to Denver")[0].alarms.map((alarm) => alarm.status), ["off", "off"]);
  assert.equal(off.calendars.find((calendar) => calendar.key === PERSONAL).enabled, false);
});

test("pauses, past alarms, unwatched calendars and invitation and all-day filters", () => {
  // Paused until resumed: every upcoming alarm.
  const forever = buildDemoSnapshot({ p_alarms_paused_until: -1 }, MONDAY_8AM, 0);
  assert.deepEqual(forever.paused, { until: -1 });
  assert.ok(forever.events.every((event) => event.alarms.every((alarm) => alarm.status === "paused")));
  // Paused until 9:25: the 9:20 standup alarm is paused, the 9:30 one rings.
  const until = Date.parse("2026-10-26T16:25:00Z");
  const paused = buildDemoSnapshot({ p_alarms_paused_until: until }, MONDAY_8AM, 0);
  assert.deepEqual(paused.paused, { until });
  assert.deepEqual(leads(byTitle(paused, "Team standup")[0]), [[10, "app", "paused"], [0, "app", "on"]]);
  // A pause that already ended pauses nothing.
  assert.deepEqual(buildDemoSnapshot({ p_alarms_paused_until: MONDAY_8AM - HOUR }, MONDAY_8AM, 0).paused, { until: 0 });
  // At 9:25 the first alarm is past and the event is still listed.
  assert.deepEqual(leads(byTitle(buildDemoSnapshot({}, until, 0), "Team standup")[0]), [[10, "app", "past"], [0, "app", "on"]]);

  const unwatched = buildDemoSnapshot({ [PERSONAL]: { selected: false } }, MONDAY_8AM, 0);
  assert.equal(unwatched.calendars.find((calendar) => calendar.key === PERSONAL).watched, false);
  assert.ok(unwatched.events.every((event) => event.calendarKey === WORK));

  const all = buildDemoSnapshot({ p_rsvp_filter: "all_events", p_ignore_all_day_events: false }, MONDAY_8AM, 0);
  assert.equal(byTitle(all, "Lunch and learn").length, 1);
  assert.equal(byTitle(all, "Sam's birthday")[0].allDay, true);
  const accepted = buildDemoSnapshot({ [WORK]: { overrides: { rsvpFilter: "accepted_only" } } }, MONDAY_8AM, 0);
  assert.deepEqual(byTitle(accepted, "Product demo with Example Co."), [], "an unanswered invitation");
  assert.deepEqual(byTitle(accepted, "Design review: onboarding flow"), [], "a tentative answer");
  assert.equal(byTitle(accepted, "Sprint retro").length, 1, "the organizer's own event");
  assert.equal(accepted.calendars.find((calendar) => calendar.key === WORK).rsvpFilter, "accepted_only");
  const allDay = buildDemoSnapshot({ [PERSONAL]: { overrides: { ignoreAllDay: false } } }, MONDAY_8AM, 0);
  assert.equal(byTitle(allDay, "Sam's birthday").length, 1);
  assert.equal(allDay.calendars.find((calendar) => calendar.key === PERSONAL).includeAllDay, true);
});

function demoDb({ connected = true, now = MONDAY_8AM } = {}) {
  const db = new FakeFirestore();
  db.now = () => now;
  db.documents.set(`accounts/${DEMO}`, { active: true, schemaVersion: 1 });
  db.documents.set(`accounts/${DEMO}/assistant/state`, { connected, connections: connected ? 1 : 0 });
  return db;
}
const devicePath = `accounts/${DEMO}/assistantDevices/${DEMO_DEVICE_ID}`;
const snapshotPath = `accounts/${DEMO}/assistantSnapshots/${DEMO_DEVICE_ID}`;
const payloadOf = (db) => JSON.parse(db.documents.get(snapshotPath).payload);

test("ensureDemoPhone registers the phone only for the demo account and keeps the snapshot fresh", async () => {
  const db = demoDb();
  // Other accounts, or no demo account configured: decided before any read.
  assert.equal(await ensureDemoPhone(db, "alice", MONDAY_8AM, DEMO), null);
  assert.equal(await ensureDemoPhone(db, DEMO, MONDAY_8AM, ""), null);
  assert.equal(await ensureDemoPhone(db, DEMO, MONDAY_8AM, undefined), null);
  assert.equal(db.reads, 0);
  assert.equal(db.writes, 0);

  assert.equal(await ensureDemoPhone(db, DEMO, MONDAY_8AM, DEMO), "registered");
  const device = db.documents.get(devicePath);
  assert.deepEqual([device.platform, device.deviceName, device.capabilities, device.demoPhone, device.fcmToken, device.apnsToken],
    ["android", DEMO_DEVICE_NAME, ["pause", "plus"], true, undefined, undefined]);
  assert.equal(payloadOf(db).builtAt, MONDAY_8AM);
  assert.ok([...db.documents.keys()].some((path) => path.startsWith(`accounts/${DEMO}/history/demo_`)), "a few days of history");
  assert.equal(await ensureDemoPhone(db, DEMO, MONDAY_8AM + 10 * MINUTE, DEMO), "current");
  assert.equal(payloadOf(db).builtAt, MONDAY_8AM);
  // Older than an hour: rebuilt, so the week rolls forward.
  assert.equal(await ensureDemoPhone(db, DEMO, MONDAY_8AM + SNAPSHOT_MAX_AGE_MS + 1, DEMO), "published");
  assert.equal(payloadOf(db).builtAt, MONDAY_8AM + SNAPSHOT_MAX_AGE_MS + 1);
  // A value saved since (its message was never delivered) is applied on the next call.
  db.documents.set(`accounts/${DEMO}/values/p_alarm_volume`, { payload: "50", updatedAt: new Date(MONDAY_8AM + 2 * HOUR) });
  assert.equal(await ensureDemoPhone(db, DEMO, MONDAY_8AM + 2 * HOUR + MINUTE, DEMO), "published");
  assert.equal(payloadOf(db).valuesAppliedThrough, MONDAY_8AM + 2 * HOUR);

  // Like a phone, nothing is registered while no assistant is connected.
  const disconnected = demoDb({ connected: false });
  assert.equal(await ensureDemoPhone(disconnected, DEMO, MONDAY_8AM, DEMO), "inactive");
  assert.equal(disconnected.documents.has(devicePath), false);
});

test("sendToDevices answers for the demo phone in-process, and never for a device marked demo in another account", async () => {
  const db = demoDb();
  const messaging = createRecordingMessaging();
  const deps = { db, messaging, logger: { info() {}, warn() {}, error() {} }, now: () => MONDAY_8AM + HOUR, demoUid: DEMO };
  await ensureDemoPhone(db, DEMO, MONDAY_8AM, DEMO);
  const devices = () => [{ id: DEMO_DEVICE_ID, ...db.documents.get(devicePath) }];

  db.documents.set(`accounts/${DEMO}/values/p_alarms_paused_until`, { payload: "-1", updatedAt: new Date(MONDAY_8AM + 30 * MINUTE) });
  const synced = await sendToDevices(deps, DEMO, "sync", { changeId: "ch_abcdefghijklmnop" }, devices());
  assert.deepEqual([synced.sent.map((device) => device.id), synced.noToken, synced.failed], [[DEMO_DEVICE_ID], [], []]);
  assert.equal(payloadOf(db).valuesAppliedThrough, MONDAY_8AM + 30 * MINUTE);
  assert.deepEqual(payloadOf(db).paused, { until: -1 });

  await sendToDevices(deps, DEMO, "publish", { requestId: "req_abc" }, devices());
  assert.equal(db.documents.get(snapshotPath).requestId, "req_abc");
  await sendToDevices(deps, DEMO, "sync", { changeId: "ch_abcdefghijklmnop" }, devices());
  assert.equal(db.documents.get(snapshotPath).requestId, undefined, "a sync publishes without a requestId");

  await sendToDevices(deps, DEMO, "ping", { pingId: "ping_1", assistant: "Claude" }, devices());
  assert.equal(db.documents.get(devicePath).lastPing.id, "ping_1");
  assert.equal(messaging.sent.length, 0, "nothing goes over FCM");

  // A state message while still connected changes nothing; after the last disconnect the phone leaves.
  await sendToDevices(deps, DEMO, "state", {}, devices());
  assert.ok(db.documents.has(devicePath));
  db.documents.set(`accounts/${DEMO}/assistant/state`, { connected: false, connections: 0 });
  await sendToDevices(deps, DEMO, "state", {}, devices());
  assert.equal(db.documents.has(devicePath), false);
  assert.equal(db.documents.has(snapshotPath), false);

  // The same device document in another account, or with no demo account configured, is a phone without a token.
  const other = new FakeFirestore();
  const marked = { id: DEMO_DEVICE_ID, platform: "android", deviceName: "Pixel 9 (demo)", capabilities: [], demoPhone: true, updatedAt: new Date(MONDAY_8AM) };
  other.documents.set(`accounts/alice/assistantDevices/${DEMO_DEVICE_ID}`, marked);
  for (const [uid, demoUid] of [["alice", DEMO], ["alice", ""], [DEMO, ""]]) {
    const sent = await sendToDevices({ ...deps, db: other, demoUid }, uid, "ping", { pingId: "ping_2" }, [marked]);
    assert.deepEqual([sent.sent, sent.noToken.map((device) => device.id)], [[], [DEMO_DEVICE_ID]]);
  }
  assert.equal(other.documents.get(`accounts/alice/assistantDevices/${DEMO_DEVICE_ID}`).lastPing, undefined);
  assert.equal(other.writes, 0);
});

test("a failure answering for the demo phone is reported like an unreachable phone, not thrown", async () => {
  const db = demoDb();
  await ensureDemoPhone(db, DEMO, MONDAY_8AM, DEMO);
  const logs = [];
  const logger = Object.fromEntries(["info", "warn", "error"].map((level) => [level, (message, fields) => logs.push(fields)]));
  // The device document is gone, so recording the ping fails.
  const device = { id: DEMO_DEVICE_ID, ...db.documents.get(devicePath) };
  db.documents.delete(devicePath);
  const sent = await sendToDevices({ db, messaging: createRecordingMessaging(), logger, now: () => MONDAY_8AM, demoUid: DEMO }, DEMO, "ping", { pingId: "p" }, [device]);
  assert.deepEqual([sent.sent, sent.failed.map((item) => item.id), sent.errors], [[], [DEMO_DEVICE_ID], { [DEMO_DEVICE_ID]: "demo:unavailable" }]);
  assert.equal(logs.at(-1).assistantEvent, "push.failed");
});

test("resetDemoAccount restores the seeded settings and clears what the review left behind", async () => {
  const db = demoDb();
  await ensureDemoPhone(db, DEMO, MONDAY_8AM, DEMO);
  db.documents.set(`accounts/${DEMO}/values/p_alarms_paused_until`, { payload: "-1", updatedAt: new Date(MONDAY_8AM) });
  db.documents.set(`accounts/${DEMO}/assistantActivity/ch_abcdefghijklmnop`, { tool: "pause_alarms" });
  db.documents.set("oauthGrants/g1", { uid: DEMO });
  await resetDemoAccount(db, DEMO);
  const paths = [...db.documents.keys()].filter((path) => path.startsWith(`accounts/${DEMO}/`)).sort();
  assert.deepEqual(paths, [`accounts/${DEMO}/assistant/state`, ...Object.keys(demoSeedValues()).map((id) => `accounts/${DEMO}/values/${id}`)].sort());
  assert.ok(db.documents.has("oauthGrants/g1"), "connections stay");
  assert.equal(db.documents.get(`accounts/${DEMO}/values/${PERSONAL}`).payload, '{"selected":true,"overrides":{"leadTimes":[5,30]}}');
  // A deleted account (its tombstone) is not brought back.
  db.documents.set("accounts/gone", { active: false, schemaVersion: 1 });
  await assert.rejects(resetDemoAccount(db, "gone"), /deleted/);
  // A new account starts active.
  await resetDemoAccount(db, "fresh");
  assert.deepEqual(db.documents.get("accounts/fresh"), { active: true, schemaVersion: 1 });
});

test("every tool works for the demo account: setup test, a change confirmed by the stand-in phone, refresh", async () => {
  const db = demoDb();
  const clock = { time: MONDAY_8AM };
  db.now = () => clock.time;
  const messaging = createRecordingMessaging();
  const handler = createMcpHandler({
    db, messaging, logger: { info() {}, warn() {}, error() {} }, now: () => clock.time,
    sleep: async (ms) => { clock.time += ms; },
    usage: createUsage({ db, increment: (n) => ({ __increment: n }), now: () => clock.time }),
    accountEmails: async () => ["reviewer@example.com"], demoUid: DEMO, sdk: loadSdk(),
  });
  await resetDemoAccount(db, DEMO);
  const token = `aot_at_${"reviewer".padEnd(43, "x")}`;
  db.documents.set("oauthGrants/g1", { uid: DEMO, clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata", clientName: "Claude", assistant: "claude",
    scopes: ["alarms.read", "alarms.write"], setupConfirmedAt: null, lastUsedAt: new Date(MONDAY_8AM), logId: "log_reviewer" });
  db.documents.set(`oauthTokens/${createHash("sha256").update(token).digest("hex")}`, { kind: "access", grantId: "g1", uid: DEMO, clientId: "c", expiresAt: new Date(MONDAY_8AM + HOUR) });

  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    req.body = text ? JSON.parse(text) : undefined;
    await handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let id = 0;
  const call = async (name, args = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = await response.json();
    assert.ok(body.result, JSON.stringify(body));
    assert.equal(body.result.isError, undefined, JSON.stringify(body.result));
    return { ...body.result, text: body.result.content.map((item) => item.text).join("\n") };
  };
  try {
    const status = await call("get_status");
    assert.match(status.text, /Phone: Pixel 9 \(demo\) \(Android; can receive changes instantly; last shared alarms just now\)/);
    assert.equal(status.structuredContent.plus, true);
    const tested = await call("test_connection", { waitSeconds: 5 });
    assert.deepEqual([tested.structuredContent.outcome, tested.structuredContent.received], ["received", [DEMO_DEVICE_NAME]]);

    const found = await call("find_events", { query: "standup" });
    const standup = found.structuredContent.events[0];
    const changed = await call("set_series_alarms", { event: standup.eventKey, leadTimes: [2] });
    assert.deepEqual(changed.structuredContent.sentTo, [DEMO_DEVICE_NAME]);
    const confirmed = await call("confirm_change", { changeId: changed.structuredContent.changeId, waitSeconds: 0 });
    assert.equal(confirmed.structuredContent.outcome, "confirmed", confirmed.text);
    const upcoming = await call("list_upcoming_alarms");
    assert.match(upcoming.text, /"Team standup", 2 min before/);
    const explained = await call("explain_alarm", { event: standup.eventKey });
    assert.match(explained.text, /series/);

    const paused = await call("pause_alarms", { indefinitely: true });
    assert.equal((await call("confirm_change", { changeId: paused.structuredContent.changeId, waitSeconds: 0 })).structuredContent.outcome, "confirmed");
    assert.match((await call("get_status")).text, /paused until resumed/);
    await call("undo", { changeId: paused.structuredContent.changeId });

    const refreshed = await call("refresh", { waitSeconds: 5 });
    assert.equal(refreshed.structuredContent.fresh, true, refreshed.text);
    const calendars = await call("list_calendars");
    assert.match(calendars.text, /"Personal"/);
    const history = await call("get_alarm_history", { days: 3 });
    assert.match(history.text, /Pixel 9 \(demo\)/);
    assert.equal(messaging.sent.length, 0);
  } finally {
    server.close();
  }
});

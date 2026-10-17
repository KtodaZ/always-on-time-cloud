"use strict";

// Drives the MCP endpoint over HTTP with the real MCP SDK, an in-memory Firestore and a simulated
// phone that answers FCM messages the way docs/ASSISTANT_PROTOCOL.md describes.

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const http = require("node:http");
const test = require("node:test");

const { FakeFirestore } = require("../testing/fake-firestore");
const { createMcpHandler, loadSdk } = require("../assistant-mcp");
const { createRecordingMessaging } = require("../assistant-push");
const { calendarKey, occurrenceKey, seriesKey } = require("../assistant-records");
const { createUsage } = require("../assistant-usage");

const T0 = Date.parse("2026-10-16T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const WORK = calendarKey("com.google", "alex@example.com", "alex@example.com");
const OTHER = calendarKey("com.google", "alex@example.com", "en.usa#holiday@group.v.calendar.google.com");
const STANDUP_SERIES = seriesKey(WORK, "7rcurring0example");
const STANDUP_START = T0 + 3 * HOUR;
const STANDUP = occurrenceKey(STANDUP_SERIES, STANDUP_START);
const DENTIST_SERIES = seriesKey(WORK, "4kq0l1v3s9example");
const DENTIST = occurrenceKey(DENTIST_SERIES, null);
const DENTIST_START = T0 + 26 * HOUR;
const TOOL_NAMES = [
  "get_status", "list_upcoming_alarms", "find_events", "explain_alarm", "list_calendars", "get_settings", "get_alarm_history",
  "set_event_alarms", "set_series_alarms", "set_calendar", "update_settings", "pause_alarms", "resume_alarms", "undo",
  "confirm_change", "test_connection", "refresh", "open_in_app",
];

function snapshotPayload({ appliedThrough = T0 - HOUR } = {}) {
  return JSON.stringify({
    device: "Pixel 9",
    timeZone: "America/Los_Angeles",
    valuesAppliedThrough: appliedThrough,
    windowEnd: T0 + 30 * 24 * HOUR,
    paused: { until: 0 },
    calendars: [
      { key: WORK, name: "Work", accountType: "com.google", watched: true, leadTimes: [10, 0], enabled: true, rsvpFilter: "not_declined", includeAllDay: false },
      { key: null, name: "Birthdays", accountType: "LOCAL", watched: true },
      { key: OTHER, name: "Holidays in United States", accountType: "com.google", watched: false },
    ],
    events: [
      { eventKey: DENTIST, seriesKey: DENTIST_SERIES, calendarKey: WORK, title: "Dentist", start: DENTIST_START, end: DENTIST_START + HOUR, allDay: false, recurring: false, rsvp: "ACCEPTED",
        alarms: [{ at: DENTIST_START - 30 * 60000, kind: "lead", minutes: 30, source: "event", status: "on" }, { at: DENTIST_START - 50 * 60000, kind: "travel", minutes: 0, source: "travel", status: "on" }] },
      { eventKey: STANDUP, seriesKey: STANDUP_SERIES, calendarKey: WORK, title: "Team standup", start: STANDUP_START, end: STANDUP_START + 15 * 60000, allDay: false, recurring: true, rsvp: "ACCEPTED",
        alarms: [{ at: STANDUP_START - 10 * 60000, kind: "lead", minutes: 10, source: "series", status: "on" }, { at: STANDUP_START, kind: "lead", minutes: 0, source: "series", status: "on" }] },
      { eventKey: null, seriesKey: null, calendarKey: null, title: "Mom's birthday", start: T0 + 2 * HOUR, allDay: true, recurring: true,
        alarms: [{ at: T0 + 2 * HOUR, kind: "lead", minutes: 0, source: "app", status: "off" }] },
    ],
  });
}

function setup({ scopes = ["alarms.read", "alarms.write"], phone = true, capabilities = ["travel", "spokenAlarms", "pause"] } = {}) {
  const db = new FakeFirestore();
  const clock = { time: T0 };
  db.now = () => clock.time;
  const messaging = createRecordingMessaging();
  const handled = new Set();
  const phoneState = { answers: true, applies: true };
  // The simulated phone reacts to messages whenever the server waits.
  const react = () => {
    messaging.sent.forEach((message, index) => {
      if (handled.has(index) || !phoneState.answers) return;
      handled.add(index);
      const devicePath = "accounts/alice/assistantDevices/11111111-1111-4111-8111-111111111111";
      const snapshotPath = "accounts/alice/assistantSnapshots/11111111-1111-4111-8111-111111111111";
      if (message.data.type === "ping") {
        db.documents.set(devicePath, { ...db.documents.get(devicePath), lastPing: { id: message.data.pingId, receivedAt: new Date(clock.time) } });
      }
      if (message.data.type === "sync" && phoneState.applies) {
        const writtenAt = db.documents.get(`accounts/alice/assistantActivity/${message.data.changeId}`).writtenAt.getTime();
        db.documents.set(snapshotPath, { schemaVersion: 1, publishedAt: new Date(clock.time), payload: snapshotPayload({ appliedThrough: writtenAt }) });
      }
      if (message.data.type === "publish") {
        db.documents.set(snapshotPath, { schemaVersion: 1, publishedAt: new Date(clock.time), requestId: message.data.requestId, payload: snapshotPayload() });
      }
    });
  };
  const handler = createMcpHandler({
    db,
    messaging,
    now: () => clock.time,
    sleep: async (ms) => {
      clock.time += ms;
      react();
    },
    usage: createUsage({ db, increment: (n) => ({ __increment: n }), now: () => clock.time }),
    accountEmails: async () => ["alex@example.com"],
    sdk: loadSdk(),
  });
  db.documents.set("accounts/alice", { active: true, schemaVersion: 1 });
  const token = "aot_at_alice-test-token";
  const grant = { uid: "alice", clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata", clientName: "Claude", assistant: "claude", scopes, setupConfirmedAt: null, lastUsedAt: new Date(T0) };
  db.documents.set("oauthGrants/g1", grant);
  db.documents.set(`oauthTokens/${createHash("sha256").update(token).digest("hex")}`, { kind: "access", grantId: "g1", uid: "alice", clientId: grant.clientId, expiresAt: new Date(T0 + HOUR) });
  // Bob is another account with his own connection and no phone.
  db.documents.set("oauthGrants/g2", { ...grant, uid: "bob" });
  db.documents.set(`oauthTokens/${createHash("sha256").update("aot_at_bob").digest("hex")}`, { kind: "access", grantId: "g2", uid: "bob", clientId: grant.clientId, expiresAt: new Date(T0 + HOUR) });
  if (phone) {
    db.documents.set("accounts/alice/assistantDevices/11111111-1111-4111-8111-111111111111", {
      platform: "android", deviceName: "Pixel 9", appVersion: "5.2.0", fcmToken: "fcm-token", capabilities, updatedAt: new Date(T0),
    });
    db.documents.set("accounts/alice/assistantSnapshots/11111111-1111-4111-8111-111111111111", { schemaVersion: 1, publishedAt: new Date(T0 - 5 * 60000), payload: snapshotPayload() });
  }
  return { db, clock, messaging, handler, token, phoneState };
}

async function withServer(handler, run) {
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    req.body = text ? JSON.parse(text) : undefined;
    await handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  let id = 0;
  const rpc = async (token, method, params) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const call = async (token, name, args = {}) => {
    const { body } = await rpc(token, "tools/call", { name, arguments: args });
    assert.ok(body.result, JSON.stringify(body));
    return { ...body.result, text: body.result.content.map((item) => item.text).join("\n") };
  };
  try {
    await run({ url, rpc, call });
  } finally {
    server.close();
  }
}

test("requests without a valid token get 401 with the protected resource metadata", async () => {
  const { handler } = setup();
  await withServer(handler, async ({ rpc }) => {
    const missing = await rpc(null, "tools/list");
    assert.equal(missing.status, 401);
    assert.match(missing.headers.get("www-authenticate"), /^Bearer resource_metadata="https:\/\/always-on-time-zombit-2026\.web\.app\/\.well-known\/oauth-protected-resource\/mcp"/);
    const bad = await rpc("aot_at_forged", "tools/list");
    assert.equal(bad.status, 401);
    assert.match(bad.headers.get("www-authenticate"), /error="invalid_token"/);
  });
});

test("initialize carries the setup-first instructions and every tool is listed with annotations", async () => {
  const { handler, token } = setup();
  await withServer(handler, async ({ rpc }) => {
    const init = await rpc(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.match(init.body.result.instructions, /If get_status says setup is not confirmed, call test_connection before anything else/);
    assert.match(init.body.result.instructions, /calendar connector/);
    const { body } = await rpc(token, "tools/list");
    const tools = body.result.tools;
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
    for (const tool of tools) {
      assert.equal(typeof tool.annotations.readOnlyHint, "boolean", tool.name);
      assert.equal(tool.annotations.openWorldHint, false, tool.name);
      assert.ok(tool.description.length > 40, tool.name);
    }
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.list_upcoming_alarms.annotations.readOnlyHint, true);
    assert.equal(byName.set_event_alarms.annotations.readOnlyHint, false);
    assert.equal(byName.undo.annotations.idempotentHint, false);
  });
});

test("status before a phone connects explains how to finish connecting", async () => {
  const { handler, token } = setup({ phone: false });
  await withServer(handler, async ({ call }) => {
    const status = await call(token, "get_status");
    assert.match(status.text, /No phone has finished connecting/);
    assert.equal(status.structuredContent.links.assistants, "https://always-on-time-zombit-2026.web.app/open/assistants");
    const test = await call(token, "test_connection");
    assert.equal(test.structuredContent.outcome, "noDevices");
    const list = await call(token, "list_upcoming_alarms");
    assert.equal(list.isError, undefined);
    assert.equal(list.structuredContent.needsPhone, true);
  });
});

test("setup test pings the phone, waits for its answer and confirms the connection", async () => {
  const { db, handler, token, messaging, phoneState } = setup();
  await withServer(handler, async ({ call }) => {
    assert.match((await call(token, "get_status")).text, /Setup is not confirmed yet: call test_connection now/);
    phoneState.answers = false;
    const silent = await call(token, "test_connection", { waitSeconds: 3 });
    assert.equal(silent.structuredContent.outcome, "noAnswer");
    assert.match(silent.text, /didn't answer.*\/open\/permissions.*\/open\/battery/);
    assert.equal(db.documents.get("oauthGrants/g1").setupConfirmedAt, null);
    phoneState.answers = true;
    const result = await call(token, "test_connection", { waitSeconds: 5 });
    assert.equal(result.structuredContent.outcome, "received");
    assert.match(result.text, /Message received on Pixel 9/);
    const ping = messaging.sent.at(-1);
    assert.deepEqual([ping.data.type, ping.data.assistant, ping.android.priority], ["ping", "Claude", "high"]);
    assert.ok(db.documents.get("oauthGrants/g1").setupConfirmedAt instanceof Date);
    assert.match((await call(token, "get_status")).text, /Setup confirmed/);
  });
  const usage = db.documents.get("assistantUsage/2026-10-16");
  assert.equal(usage.setupTests.received, 1);
  assert.equal(usage.setupTests.noAnswer, 1);
  assert.equal(usage.tools.test_connection, 2);
  assert.equal(usage.activeConnections.claude, 1);
  assert.equal(usage.weeklyActive.claude, 1);
});

test("reads come from the snapshot, say what they are based on, and use short keys", async () => {
  const { handler, token } = setup();
  await withServer(handler, async ({ call }) => {
    const upcoming = await call(token, "list_upcoming_alarms");
    assert.match(upcoming.text, /^As of 4:55 AM from Pixel 9\./);
    assert.deepEqual(upcoming.structuredContent.alarms.map((alarm) => alarm.title), ["Team standup", "Team standup"],
      "turned-off alarms and alarms after the range are left out");
    assert.match(upcoming.text, new RegExp(`Team standup, 10 min before \\[${STANDUP.slice(0, 14)}\\]`));
    assert.equal(upcoming.structuredContent.alarms[0].at, "2026-10-16T07:50:00-07:00");
    const withOff = await call(token, "list_upcoming_alarms", { includeOff: true, to: "2026-10-18" });
    assert.equal(withOff.structuredContent.total, 5);
    const work = await call(token, "list_upcoming_alarms", { calendar: "alex@example.com", to: "2026-10-18" });
    assert.equal(work.structuredContent.total, 4);
    const found = await call(token, "find_events", { query: "STANDUP team" });
    assert.equal(found.structuredContent.events[0].eventKey, STANDUP);
    const none = await call(token, "find_events", { query: "board meeting" });
    assert.match(none.text, /No matching event in the next 30 days on watched calendars.*calendar connector or list_calendars/);
    const calendars = await call(token, "list_calendars");
    assert.match(calendars.text, /Birthdays \(local\): watched \[local only: change it in the app\]/);
    assert.match(calendars.text, /Holidays in United States \(Google\): not watched/);
    const explained = await call(token, "explain_alarm", { event: STANDUP.slice(0, 14) });
    assert.match(explained.text, /7:50 AM: 10 min before, from the rule for this recurring series/);
  });
});

test("travel alarms mention Plus for live traffic, and the Plus link is counted", async () => {
  const { db, handler, token } = setup();
  await withServer(handler, async ({ call }) => {
    const explained = await call(token, "explain_alarm", { event: DENTIST });
    assert.match(explained.text, /live traffic updates need Always On Time Plus: https:\/\/always-on-time-zombit-2026\.web\.app\/open\/plus\?source=assistant/);
    const link = await call(token, "open_in_app", { destination: "plus" });
    assert.equal(link.structuredContent.link, "https://always-on-time-zombit-2026.web.app/open/plus?source=assistant");
    const event = await call(token, "open_in_app", { destination: "event", key: DENTIST.slice(0, 12) });
    assert.equal(event.structuredContent.link, `https://always-on-time-zombit-2026.web.app/open/event/${DENTIST}`);
  });
  assert.equal(db.documents.get("assistantUsage/2026-10-16").plusGate, 2);
});

test("a change from Google Calendar ids is validated, logged, pushed and confirmed", async () => {
  const { db, handler, token, messaging } = setup();
  await withServer(handler, async ({ call }) => {
    const changed = await call(token, "set_event_alarms", {
      googleCalendarId: "alex@example.com", googleEventId: "7rcurring0example_20261016T150000Z", leadTimes: [30, 5, 30],
    });
    assert.equal(changed.isError, undefined, changed.text);
    assert.match(changed.text, /Set "Team standup" \(Fri, Oct 16, 8:00 AM\) to ring 30 min before, 5 min before\. Saved as change ch_/);
    const { changeId } = changed.structuredContent;
    assert.deepEqual(JSON.parse(db.documents.get(`accounts/alice/values/${STANDUP}`).payload), { leadTimes: [30, 5], enabled: true });
    const activity = db.documents.get(`accounts/alice/assistantActivity/${changeId}`);
    assert.deepEqual(activity.records[STANDUP], { before: null, after: '{"leadTimes":[30,5],"enabled":true}' });
    assert.equal(activity.assistant, "Claude");
    assert.equal(activity.tool, "set_event_alarms");
    // writtenAt is the values' own update time, which is what phones report back.
    assert.equal(activity.writtenAt.getTime(), db.updateTimes.get(`accounts/alice/values/${STANDUP}`));
    assert.ok(Math.abs(activity.expiresAt.getTime() - activity.writtenAt.getTime() - 30 * 24 * HOUR) < 1000);
    const sync = messaging.sent.at(-1);
    assert.deepEqual([sync.token, sync.data.type, sync.data.changeId], ["fcm-token", "sync", changeId]);
    const confirmed = await call(token, "confirm_change", { changeId, waitSeconds: 5 });
    assert.deepEqual([confirmed.structuredContent.outcome, confirmed.text], ["confirmed", "Confirmed on Pixel 9."]);
    const same = await call(token, "set_event_alarms", { event: STANDUP, leadTimes: [5, 30] });
    assert.match(same.text, /already how it's set/);
  });
});

test("an unconfirmed change says it will apply when the phone is online", async () => {
  const { handler, token, phoneState } = setup();
  phoneState.applies = false;
  await withServer(handler, async ({ call }) => {
    const changed = await call(token, "set_series_alarms", { event: STANDUP, mode: "off" });
    assert.match(changed.text, /Turned off alarms for every "Team standup"/);
    const pending = await call(token, "confirm_change", { changeId: changed.structuredContent.changeId, waitSeconds: 2 });
    assert.equal(pending.structuredContent.outcome, "pending");
    assert.match(pending.text, /will apply it when it's online/);
  });
});

test("series, calendar and settings changes write the right records and refuse what can't change", async () => {
  const { db, handler, token } = setup();
  await withServer(handler, async ({ call }) => {
    assert.match((await call(token, "set_series_alarms", { event: DENTIST, leadTimes: [10] })).text, /doesn't repeat; use set_event_alarms/);
    const recurring = await call(token, "set_event_alarms", { googleCalendarId: "alex@example.com", googleEventId: "7rcurring0example", leadTimes: [10] });
    assert.equal(recurring.isError, true);
    assert.match(recurring.text, /recurring event/);
    await call(token, "set_series_alarms", { googleCalendarId: "alex@example.com", googleEventId: "7rcurring0example", leadTimes: [15] });
    assert.deepEqual(JSON.parse(db.documents.get(`accounts/alice/values/${STANDUP_SERIES}`).payload), { leadTimes: [15], enabled: true });
    assert.match((await call(token, "set_calendar", { calendar: "Birthdays", watched: false })).text, /local calendar/);
    await call(token, "set_calendar", { calendar: "Holidays in United States", watched: true, leadTimes: [1440], includeAllDay: true });
    assert.deepEqual(JSON.parse(db.documents.get(`accounts/alice/values/${OTHER}`).payload),
      { selected: true, overrides: { leadTimes: [1440], ignoreAllDay: false } });
    await call(token, "update_settings", { settings: { snoozeMinutes: 9, defaultLeadTimes: [0, 10], theme: "dark", vibration: null } });
    assert.equal(db.documents.get("accounts/alice/values/p_snooze_duration_minutes").payload, "9");
    assert.equal(db.documents.get("accounts/alice/values/p_default_lead_times_csv").payload, JSON.stringify("[0,10]"));
    assert.equal(db.documents.get("accounts/alice/values/p_theme_preference").payload, '"dark"');
    const invalid = await call(token, "update_settings", { settings: { snoozeMinutes: 0 } });
    assert.equal(invalid.isError, true);
    const unknown = await call(token, "update_settings", { settings: { alarms_paused_until: 0 } });
    assert.equal(unknown.isError, true);
    const settings = await call(token, "get_settings");
    assert.equal(settings.structuredContent.settings.snoozeMinutes, 9);
    assert.deepEqual(settings.structuredContent.settings.defaultLeadTimes, [0, 10]);
    const past = await call(token, "set_event_alarms", { event: STANDUP, leadTimes: [5] });
    assert.equal(past.isError, undefined);
  });
});

test("pause needs a phone that supports it; resume clears it", async () => {
  const unsupported = setup({ capabilities: ["travel"] });
  await withServer(unsupported.handler, async ({ call }) => {
    assert.match((await call(unsupported.token, "pause_alarms", { indefinitely: true })).text, /can't be paused remotely yet/);
  });
  const { db, handler, token } = setup();
  await withServer(handler, async ({ call }) => {
    assert.equal((await call(token, "pause_alarms", { until: "2026-10-15T09:00" })).isError, true);
    const paused = await call(token, "pause_alarms", { until: "2026-10-17T09:00" });
    assert.match(paused.text, /Paused alarms until Sat, Oct 17, 9:00 AM/);
    assert.equal(db.documents.get("accounts/alice/values/p_alarms_paused_until").payload, String(Date.parse("2026-10-17T16:00:00Z")));
    await call(token, "resume_alarms");
    assert.equal(db.documents.get("accounts/alice/values/p_alarms_paused_until").payload, "0");
  });
});

test("undo restores the previous values once, and refuses after a newer change", async () => {
  const { db, handler, token } = setup();
  db.documents.set(`accounts/alice/values/${STANDUP_SERIES}`, { payload: '{"leadTimes":[10,0],"enabled":true,"volume":40}' });
  await withServer(handler, async ({ call }) => {
    const changed = await call(token, "set_series_alarms", { event: STANDUP, leadTimes: [20] });
    assert.deepEqual(JSON.parse(db.documents.get(`accounts/alice/values/${STANDUP_SERIES}`).payload), { leadTimes: [20], enabled: true, volume: 40 });
    const undone = await call(token, "undo", { changeId: changed.structuredContent.changeId });
    assert.match(undone.text, /^Undid: Set every "Team standup" to ring 20 min before\. Saved as change ch_/);
    assert.equal(db.documents.get(`accounts/alice/values/${STANDUP_SERIES}`).payload, '{"leadTimes":[10,0],"enabled":true,"volume":40}');
    assert.match((await call(token, "undo", { changeId: changed.structuredContent.changeId })).text, /already undone/);
    // A record that didn't exist before is cleared with "null" on undo.
    const fresh = await call(token, "set_event_alarms", { event: DENTIST, mode: "off" });
    assert.deepEqual(JSON.parse(db.documents.get(`accounts/alice/values/${DENTIST}`).payload), { leadTimes: [30], enabled: false });
    await call(token, "set_event_alarms", { event: DENTIST, leadTimes: [45] });
    assert.match((await call(token, "undo", { changeId: fresh.structuredContent.changeId })).text, /changed again since/);
    const latest = Object.entries(db.dump()).filter(([path, doc]) => path.includes("assistantActivity") && doc.records?.[DENTIST]?.after?.includes("45"));
    await call(token, "undo", { changeId: latest[0][0].split("/").pop() });
    await call(token, "undo", { changeId: fresh.structuredContent.changeId });
    assert.equal(db.documents.get(`accounts/alice/values/${DENTIST}`).payload, "null");
  });
  assert.equal(db.documents.get("assistantUsage/2026-10-16").undos, 3);
});

test("refresh asks the phone to publish and returns the fresh copy", async () => {
  const { handler, token, messaging, phoneState } = setup();
  await withServer(handler, async ({ call }) => {
    const fresh = await call(token, "refresh", { waitSeconds: 5 });
    assert.equal(fresh.structuredContent.fresh, true);
    assert.match(fresh.text, /^Fresh from Pixel 9: 3 events with 4 upcoming alarms on 2 watched calendars\./);
    assert.equal(messaging.sent.at(-1).data.type, "publish");
    phoneState.answers = false;
    const stale = await call(token, "refresh", { waitSeconds: 2 });
    assert.equal(stale.structuredContent.fresh, false);
    assert.match(stale.text, /didn't answer in time/);
  });
});

test("alarm history lists recent alarms in the phone's time zone", async () => {
  const { db, handler, token } = setup();
  db.documents.set("accounts/alice/history/h1", { createdAt: T0 - HOUR, payload: JSON.stringify({
    deviceId: "d", deviceName: "Pixel 9", title: "Team standup", scheduledTime: T0 - 21 * HOUR, firedTime: T0 - 21 * HOUR,
    action: "DISMISSED", actionTime: T0 - 21 * HOUR + 120000, snoozeCount: 2, snoozeMinutes: 5, createdAt: T0 - HOUR,
  }) });
  db.documents.set("accounts/alice/history/h2", { createdAt: T0 - 20 * 24 * HOUR, payload: "{}" });
  await withServer(handler, async ({ call }) => {
    const history = await call(token, "get_alarm_history", { days: 2 });
    assert.match(history.text, /Thu, Oct 15, 8:00 AM: Team standup: snoozed 2× \(5 min\), dismissed at 8:02 AM \(Pixel 9\)/);
    assert.equal(history.structuredContent.total, 1);
  });
});

test("tokens only reach their own account, and read-only connections cannot change anything", async () => {
  const { db, handler, token } = setup();
  await withServer(handler, async ({ call }) => {
    const bob = await call("aot_at_bob", "list_upcoming_alarms");
    assert.equal(bob.structuredContent.needsPhone, true, "Bob's token never sees Alice's snapshot");
    await call("aot_at_bob", "update_settings", { settings: { alarmVolume: 10 } });
    assert.equal(db.documents.get("accounts/alice/values/p_alarm_volume"), undefined);
    assert.equal(db.documents.get("accounts/bob/values/p_alarm_volume").payload, "10");
    const alice = await call(token, "resume_alarms");
    const { changeId } = alice.structuredContent;
    assert.equal((await call("aot_at_bob", "confirm_change", { changeId })).isError, true, "Bob cannot see Alice's change");
    assert.equal((await call("aot_at_bob", "undo", { changeId })).isError, true, "or undo it");
    assert.equal(db.documents.get("accounts/alice/values/p_alarms_paused_until").payload, "0");
  });
  const readOnly = setup({ scopes: ["alarms.read"] });
  await withServer(readOnly.handler, async ({ call }) => {
    const refused = await call(readOnly.token, "resume_alarms");
    assert.equal(refused.isError, true);
    assert.match(refused.text, /can only read/);
  });
});

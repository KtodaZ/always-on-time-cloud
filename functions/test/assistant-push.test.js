"use strict";

// Routing of assistant pushes: FCM for Android (unchanged), APNs alert pushes for iPhones.

const assert = require("node:assert/strict");
const test = require("node:test");

const { FakeFirestore } = require("../testing/fake-firestore");
const {
  CHANGE_CATEGORY, buildAssistantApnsRequest, canReceive, createRecordingApns, createRecordingMessaging, sendToDevices,
} = require("../assistant-push");
const { deliveryFields } = require("../assistant-log");
const { applyChange, createToolContext } = require("../assistant-tool-context");
const { TOOLS } = require("../assistant-tools");
const { ApnsConfigError } = require("../apns-transport");

const T0 = Date.parse("2026-10-22T12:00:00Z");
const ANDROID = "11111111-1111-4111-8111-111111111111";
const IPHONE = "22222222-2222-4222-8222-222222222222";
const OLD_IPHONE = "33333333-3333-4333-8333-333333333333";
const APNS_TOKEN = "ab".repeat(32);
const KEY_HASH = "c0".repeat(32);

function setup({ apns = createRecordingApns(), devices = ["android", "iphone", "oldIphone"] } = {}) {
  const db = new FakeFirestore();
  db.now = () => T0;
  db.documents.set("accounts/alice", { active: true, schemaVersion: 1 });
  const docs = {
    android: [ANDROID, { platform: "android", deviceName: "Pixel 9", appVersion: "5.2.0", fcmToken: "fcm-1", capabilities: ["pause"], updatedAt: new Date(T0 - 1000) }],
    iphone: [IPHONE, {
      platform: "ios", deviceName: "iPhone 17", appVersion: "1.4.0", apnsToken: APNS_TOKEN, apnsEnvironment: "production",
      deviceKeyHash: KEY_HASH, capabilities: ["pause"], updatedAt: new Date(T0 - 2000),
    }],
    // An iPhone app from before APNs registration: no token at all.
    oldIphone: [OLD_IPHONE, { platform: "ios", deviceName: "iPhone 15", appVersion: "1.3.0", capabilities: [], updatedAt: new Date(T0 - 3000) }],
  };
  for (const name of devices) db.documents.set(`accounts/alice/assistantDevices/${docs[name][0]}`, docs[name][1]);
  const messaging = createRecordingMessaging();
  const logs = [];
  const logger = Object.fromEntries(["info", "warn", "error"].map((level) => [level, (message, fields) => logs.push({ level, message, ...fields })]));
  return { db, messaging, apns, logger, logs, deps: { db, messaging, apns, logger, logId: "log_alice", now: () => T0 } };
}

const ids = (devices) => devices.map((device) => device.id);

test("Android gets the same FCM message as before; iPhones with an APNs token get APNs; others have no token", async () => {
  const { deps, messaging, apns } = setup();
  const sent = await sendToDevices(deps, "alice", "sync", { changeId: "ch_abcdefghijklmnop" });
  assert.deepEqual(messaging.sent, [{
    token: "fcm-1",
    data: { type: "sync", changeId: "ch_abcdefghijklmnop" },
    android: { priority: "high", ttl: 10 * 60 * 1000 },
  }]);
  assert.equal(apns.sent.length, 1);
  assert.equal(apns.sent[0].token, APNS_TOKEN);
  assert.equal(apns.sent[0].environment, "production");
  assert.deepEqual(ids(sent.sent).sort(), [ANDROID, IPHONE].sort());
  assert.deepEqual(ids(sent.noToken), [OLD_IPHONE]);
  assert.deepEqual([sent.failed, sent.removed, sent.skipped, sent.errors], [[], [], [], {}]);
});

test("an Android-only account sends exactly what it did before APNs routing", async () => {
  const { deps, messaging } = setup({ devices: ["android"], apns: null });
  const sent = await sendToDevices(deps, "alice", "ping", { pingId: "ping_1", assistant: "Claude" });
  assert.deepEqual(messaging.sent, [{
    token: "fcm-1", data: { type: "ping", pingId: "ping_1", assistant: "Claude" }, android: { priority: "high", ttl: 2 * 60 * 1000 },
  }]);
  assert.deepEqual(ids(sent.sent), [ANDROID]);
});

test("canReceive: an FCM token, or an iPhone with a well-formed APNs token and environment", () => {
  assert.equal(canReceive({ platform: "android", fcmToken: "t" }), true);
  assert.equal(canReceive({ platform: "ios", apnsToken: APNS_TOKEN, apnsEnvironment: "development" }), true);
  assert.equal(canReceive({ platform: "ios" }), false);
  assert.equal(canReceive({ platform: "ios", apnsToken: APNS_TOKEN }), false);
  assert.equal(canReceive({ platform: "ios", apnsToken: "AB".repeat(32), apnsEnvironment: "production" }), false);
  assert.equal(canReceive({ platform: "ios", apnsToken: APNS_TOKEN, apnsEnvironment: "sandbox" }), false);
  assert.equal(canReceive({ platform: "android", apnsToken: APNS_TOKEN, apnsEnvironment: "production" }), false);
  assert.equal(canReceive({ platform: "android", fcmToken: "" }), false);
});

test("APNs requests: alert push type, priority 10, expiration from the type's TTL, collapse id and category by type", async () => {
  const at = T0 + 123;
  const quiet = buildAssistantApnsRequest({ type: "sync", data: { changeId: "ch_abcdefghijklmnop" }, deviceId: IPHONE, at });
  assert.deepEqual(quiet.headers, {
    "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": "aot-sync", "apns-expiration": String(Math.floor((at + 600000) / 1000)),
  });
  assert.equal(quiet.body, JSON.stringify({
    aps: { alert: { title: "Keeping your alarms up to date", body: "Checking for assistant changes." }, "mutable-content": 1, "interruption-level": "passive" },
    aot: { v: 1, kind: "assistant", type: "sync", at, deviceId: IPHONE, changeId: "ch_abcdefghijklmnop" },
  }));

  const alert = buildAssistantApnsRequest({ type: "sync", data: { changeId: "ch_abcdefghijklmnop" }, deviceId: IPHONE, at, alert: "paused", assistant: "Claude" });
  assert.equal(alert.headers["apns-collapse-id"], "aot-change-ch_abcdefghijklmnop");
  assert.deepEqual(JSON.parse(alert.body), {
    aps: {
      alert: { title: "An assistant changed your alarms", body: "Open Always On Time to review or undo." },
      "mutable-content": 1, "interruption-level": "active", category: CHANGE_CATEGORY,
    },
    aot: { v: 1, kind: "assistant", type: "sync", at, deviceId: IPHONE, changeId: "ch_abcdefghijklmnop", alert: "paused", assistant: "Claude" },
  });
  assert.equal(CHANGE_CATEGORY, "AOT_ASSISTANT_CHANGE");

  const ping = buildAssistantApnsRequest({ type: "ping", data: { pingId: "ping_abc", assistant: "ChatGPT" }, deviceId: IPHONE, at });
  assert.equal(ping.headers["apns-collapse-id"], "aot-assistant-ping");
  assert.equal(ping.headers["apns-expiration"], String(Math.floor((at + 120000) / 1000)));
  assert.deepEqual(JSON.parse(ping.body), {
    aps: { alert: { title: "Always On Time is connected", body: "ChatGPT can reach this iPhone." }, "mutable-content": 1, "interruption-level": "active" },
    aot: { v: 1, kind: "assistant", type: "ping", at, deviceId: IPHONE, pingId: "ping_abc", assistant: "ChatGPT" },
  });
  assert.equal(JSON.parse(ping.body).aps.sound, undefined, "the ping is silent");

  const publish = buildAssistantApnsRequest({ type: "publish", data: { requestId: "req_abc" }, deviceId: IPHONE, at });
  assert.equal(publish.headers["apns-collapse-id"], "aot-sync");
  assert.deepEqual(JSON.parse(publish.body), {
    aps: { alert: { title: "Keeping your alarms up to date", body: "Checking for assistant changes." }, "mutable-content": 1, "interruption-level": "passive" },
    aot: { v: 1, kind: "assistant", type: "publish", at, deviceId: IPHONE, requestId: "req_abc" },
  });
  assert.throws(() => buildAssistantApnsRequest({ type: "state", deviceId: IPHONE, at }), TypeError);
});

test("APNs payloads carry no uid or record data and stay under 4 KB whatever the assistant is called", () => {
  const name = `${"\u{1F600}".repeat(200)}‮evil\u0000`;
  for (const [type, data, extra] of [
    ["ping", { pingId: "p".repeat(64), assistant: name }, {}],
    ["sync", { changeId: "ch_abcdefghijklmnop" }, { alert: "alerts_reduced", assistant: name }],
  ]) {
    const { body } = buildAssistantApnsRequest({ type, data, deviceId: IPHONE, at: T0, ...extra });
    assert.ok(Buffer.byteLength(body, "utf8") <= 4096);
    const payload = JSON.parse(body);
    assert.doesNotMatch(body, /alice|uid|payload/);
    assert.ok([...payload.aot.assistant].length <= 60, "the assistant name is cut at 60 characters");
    assert.doesNotMatch(payload.aot.assistant, /[‮\u0000]/, "control and bidi characters are stripped");
  }
});

test("iPhones skip state messages; Android still gets them", async () => {
  const { deps, messaging, apns } = setup();
  const sent = await sendToDevices(deps, "alice", "state", {});
  assert.deepEqual(messaging.sent.map((message) => message.data.type), ["state"]);
  assert.equal(apns.sent.length, 0);
  assert.deepEqual(ids(sent.sent), [ANDROID]);
  assert.deepEqual(ids(sent.skipped), [IPHONE]);
  assert.deepEqual(ids(sent.noToken), [OLD_IPHONE]);
  assert.deepEqual(deliveryFields("state", sent).devices.map((device) => device.result), ["sent", "skipped", "noToken"]);
});

test("APNs 410 and 400 BadDeviceToken remove the device, but only while its token is unchanged", async () => {
  for (const [response, removed] of [
    [{ status: 410, reason: "Unregistered" }, true],
    [{ status: 400, reason: "BadDeviceToken" }, true],
    // A wrong APNS_TOPIC answers this for every iPhone; it must not delete their devices.
    [{ status: 400, reason: "DeviceTokenNotForTopic" }, false],
    [{ status: 400, reason: "PayloadTooLarge" }, false],
    [{ status: 429, reason: "TooManyRequests" }, false],
    [{ status: 500, reason: "InternalServerError" }, false],
    [{ status: 503 }, false],
  ]) {
    const { deps, db, logs } = setup({ devices: ["iphone"], apns: createRecordingApns({ respond: () => response }) });
    const sent = await sendToDevices(deps, "alice", "ping", { pingId: "ping_1", assistant: "Claude" });
    const code = `apns:${response.reason ?? `status_${response.status}`}`;
    assert.deepEqual(sent.errors, { [IPHONE]: code });
    assert.deepEqual(ids(sent.failed), [IPHONE]);
    assert.deepEqual(ids(sent.removed), removed ? [IPHONE] : [], code);
    assert.equal(db.documents.has(`accounts/alice/assistantDevices/${IPHONE}`), !removed, code);
    assert.equal(logs.at(-1).assistantEvent, removed ? "push.invalid_token_removed" : "push.failed");
    assert.equal(logs.at(-1).errorCode, code);
  }

  // The phone registered a new token while the push was in flight: its document stays.
  const { deps, db } = setup({ devices: ["iphone"] });
  deps.apns = createRecordingApns({
    respond: () => {
      const path = `accounts/alice/assistantDevices/${IPHONE}`;
      db.documents.set(path, { ...db.documents.get(path), apnsToken: "cd".repeat(32) });
      return { status: 410, reason: "Unregistered" };
    },
  });
  const sent = await sendToDevices(deps, "alice", "sync", { changeId: "ch_abcdefghijklmnop" });
  assert.deepEqual(sent.removed, []);
  assert.equal(db.documents.get(`accounts/alice/assistantDevices/${IPHONE}`).apnsToken, "cd".repeat(32));
});

test("an FCM rejection still removes only the token FCM rejected", async () => {
  const { deps, db, messaging } = setup();
  messaging.sendEach = async (messages) => ({ responses: messages.map(() => ({ success: false, error: { code: "messaging/registration-token-not-registered" } })) });
  const sent = await sendToDevices(deps, "alice", "sync", { changeId: "ch_abcdefghijklmnop" });
  assert.deepEqual(ids(sent.removed), [ANDROID]);
  assert.deepEqual(ids(sent.sent), [IPHONE]);
  assert.equal(db.documents.has(`accounts/alice/assistantDevices/${IPHONE}`), true);
});

test("without a configured APNs transport iPhones fail as apns:unconfigured and FCM is unaffected", async () => {
  for (const apns of [null, { send: async () => { throw new ApnsConfigError("APNS_AUTH_KEY_P8 is missing"); } }]) {
    const { deps, db, messaging } = setup({ apns });
    const sent = await sendToDevices(deps, "alice", "sync", { changeId: "ch_abcdefghijklmnop" });
    assert.equal(messaging.sent.length, 1);
    assert.deepEqual(ids(sent.sent), [ANDROID]);
    assert.deepEqual(sent.errors, { [IPHONE]: "apns:unconfigured" });
    assert.deepEqual(sent.removed, []);
    assert.equal(db.documents.has(`accounts/alice/assistantDevices/${IPHONE}`), true);
  }
  const { deps } = setup({ apns: { send: async () => { throw new Error("socket hang up"); } } });
  const sent = await sendToDevices(deps, "alice", "publish", { requestId: "req_1" });
  assert.deepEqual(sent.errors, { [IPHONE]: "apns:unavailable" });
});

function toolContext(env, clientName = "Claude") {
  return createToolContext({
    db: env.db,
    uid: "alice",
    grant: { grantId: "g1", clientName, assistant: "claude", scopes: ["alarms.read", "alarms.write"], setupConfirmedAt: null },
    logId: "log_alice",
    origin: "https://alwaysontime.zombit.io",
    now: () => env.db.now(),
    sleep: env.sleep ?? (async () => {}),
    messaging: env.messaging,
    apns: env.apns,
    logger: env.logger,
  });
}

test("a change that could stop alarms reaches iPhones as an alert with Undo; other changes stay quiet", async () => {
  const env = setup({ devices: ["android", "iphone"] });
  const ctx = toolContext(env);
  const paused = await applyChange(ctx, {
    recordIds: ["p_alarms_paused_until"], build: () => ({ p_alarms_paused_until: -1 }), tool: "pause_alarms", summary: "Paused alarms",
  });
  assert.equal(paused.data.alert, "paused");
  const [alertPush] = env.apns.sent;
  assert.equal(alertPush.headers["apns-collapse-id"], `aot-change-${paused.data.changeId}`);
  assert.equal(alertPush.payload.aps.category, "AOT_ASSISTANT_CHANGE");
  assert.deepEqual([alertPush.payload.aot.alert, alertPush.payload.aot.assistant, alertPush.payload.aot.changeId], ["paused", "Claude", paused.data.changeId]);
  // Android's message is unchanged: no alert fields.
  assert.deepEqual(env.messaging.sent[0].data, { type: "sync", changeId: paused.data.changeId });

  const volume = await applyChange(ctx, {
    recordIds: ["p_alarm_volume"], build: () => ({ p_alarm_volume: 90 }), tool: "update_settings", summary: "Raised the volume",
  });
  const quiet = env.apns.sent[1];
  assert.equal(volume.data.alert, undefined);
  assert.equal(quiet.headers["apns-collapse-id"], "aot-sync");
  assert.equal(quiet.payload.aps["interruption-level"], "passive");
  assert.equal(quiet.payload.aps.category, undefined);
  assert.equal(quiet.payload.aot.alert, undefined);
});

test("test_connection and get_status treat an iPhone with an APNs token as reachable", async () => {
  const env = setup({ devices: ["iphone", "oldIphone"] });
  // The simulated notification extension answers the ping the way assistantDeviceApi records it.
  env.sleep = async () => {
    for (const request of env.apns.sent) {
      if (request.payload.aot.type !== "ping") continue;
      const path = `accounts/alice/assistantDevices/${request.payload.aot.deviceId}`;
      env.db.documents.set(path, { ...env.db.documents.get(path), lastPing: { id: request.payload.aot.pingId, receivedAt: new Date(T0) } });
    }
  };
  env.db.documents.set("oauthGrants/g1", { uid: "alice" });
  const ctx = toolContext(env);
  const tool = (name) => TOOLS.find((item) => item.name === name);
  const tested = await tool("test_connection").handler(ctx, { waitSeconds: 5 });
  assert.equal(tested.data.outcome, "partial");
  assert.deepEqual(tested.data.received, ["iPhone 17"]);
  assert.deepEqual(tested.data.cannotReceive, ["iPhone 15"]);
  assert.equal(env.apns.sent[0].payload.aps.alert.body, "Claude can reach this iPhone.");
  const status = await tool("get_status").handler(ctx, {});
  assert.deepEqual(status.data.phones.map((phone) => [phone.name, phone.canReceiveMessages]), [["iPhone 17", true], ["iPhone 15", false]]);
});

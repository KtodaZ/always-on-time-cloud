"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { FIELDS, clientIdForLog, deliveryFields, errorFields, logEvent } = require("../assistant-log");
const { createRecordingMessaging, sendToDevices } = require("../assistant-push");
const { FakeFirestore } = require("../testing/fake-firestore");

const capture = () => {
  const logs = [];
  const logger = Object.fromEntries(["info", "warn", "error"].map((level) => [level, (message, fields) => logs.push({ level, message, ...fields })]));
  return { logs, logger };
};

test("only allowlisted fields are written, so titles and payloads are dropped", () => {
  const { logs, logger } = capture();
  logEvent(logger, "info", "tool.call", {
    tool: "set_event_alarms", outcome: "ok", changeId: "ch_abc", title: "Dentist", summary: "Set Dentist", payload: '{"leadTimes":[5]}',
    args: { query: "Dentist" }, token: "aot_at_x",
  });
  assert.deepEqual(logs, [{
    level: "info", message: "Assistant tool.call set_event_alarms ok", assistantEvent: "tool.call", tool: "set_event_alarms", outcome: "ok", changeId: "ch_abc",
  }]);
});

test("accounts are named by logId: a uid passed by mistake is dropped", () => {
  const { logs, logger } = capture();
  assert.ok(!FIELDS.includes("uid"));
  logEvent(logger, "info", "callable.undo", { uid: "alice", logId: "log_abc", outcome: "ok" });
  assert.deepEqual(logs, [{ level: "info", message: "Assistant callable.undo ok", assistantEvent: "callable.undo", logId: "log_abc", outcome: "ok" }]);
});

test("error messages lose account paths and email addresses", () => {
  const error = Object.assign(new Error(
    "5 NOT_FOUND: No document to update: projects/p/databases/(default)/documents/accounts/Xy9aBc12/values/p_x (alex.r+cal@example.co.uk)",
  ), { code: 5 });
  assert.deepEqual(errorFields(error), {
    errorName: "Error",
    errorCode: "5",
    errorMessage: "5 NOT_FOUND: No document to update: projects/p/databases/(default)/documents/accounts/{uid}/values/p_x ({email})",
  });
});

test("a broken logger never throws", () => {
  assert.doesNotThrow(() => logEvent({ info: () => { throw new Error("down"); } }, "info", "prune", {}));
  assert.doesNotThrow(() => logEvent(undefined, "info", "prune", {}));
});

test("JSON parse errors keep their class but not the quoted text", () => {
  let parseError;
  try {
    JSON.parse('{"title":"Dentist"');
  } catch (error) {
    parseError = error;
  }
  assert.deepEqual(errorFields(parseError), { errorName: "SyntaxError" });
  assert.deepEqual(errorFields(Object.assign(new Error("deadline exceeded"), { code: 4 })), { errorName: "Error", errorCode: "4", errorMessage: "deadline exceeded" });
});

test("client ids lose any query string", () => {
  assert.equal(clientIdForLog("https://claude.ai/oauth/meta?x=1#y"), "https://claude.ai/oauth/meta");
  assert.equal(clientIdForLog("aot_client_abc"), "aot_client_abc");
});

test("pushes report each device's result, and invalid tokens are removed and logged", async () => {
  const db = new FakeFirestore();
  const { logs, logger } = capture();
  const updatedAt = new Date();
  db.documents.set("accounts/alice/assistantDevices/d-ok", { fcmToken: "t1", updatedAt });
  db.documents.set("accounts/alice/assistantDevices/d-gone", { fcmToken: "t2", updatedAt });
  db.documents.set("accounts/alice/assistantDevices/d-busy", { fcmToken: "t3", updatedAt });
  db.documents.set("accounts/alice/assistantDevices/d-ios", { platform: "ios", updatedAt });
  const messaging = createRecordingMessaging();
  messaging.sendEach = async (messages) => ({
    responses: messages.map((message) => (message.token === "t1" ? { success: true }
      : { success: false, error: { code: message.token === "t2" ? "messaging/registration-token-not-registered" : "messaging/internal-error" } })),
  });
  const sent = await sendToDevices({ db, messaging, logger, logId: "log_alice" }, "alice", "sync", { changeId: "ch_x" });
  const fields = deliveryFields("sync", sent);
  assert.equal(fields.type, "sync");
  assert.deepEqual(Object.fromEntries(fields.devices.map((device) => [device.deviceId, device.result])), {
    "d-ok": "sent", "d-gone": "removed", "d-busy": "failed", "d-ios": "noToken",
  });
  assert.equal(db.documents.get("accounts/alice/assistantDevices/d-gone"), undefined);
  assert.deepEqual(logs.map((entry) => [entry.assistantEvent, entry.deviceId, entry.errorCode]).sort(), [
    ["push.failed", "d-busy", "messaging/internal-error"],
    ["push.invalid_token_removed", "d-gone", "messaging/registration-token-not-registered"],
  ]);
  assert.ok(logs.every((entry) => entry.logId === "log_alice"));
  assert.ok(!JSON.stringify(logs).includes("t2"));
  assert.ok(!JSON.stringify(logs).includes('"alice"'));
});

test("a device that registered a new token since the send is kept", async () => {
  const db = new FakeFirestore();
  const { logger } = capture();
  db.documents.set("accounts/alice/assistantDevices/d1", { fcmToken: "old", updatedAt: new Date() });
  const messaging = {
    async sendEach(messages) {
      // The phone refreshes its token while the send is in flight.
      db.documents.set("accounts/alice/assistantDevices/d1", { fcmToken: "new", updatedAt: new Date() });
      return { responses: messages.map(() => ({ success: false, error: { code: "messaging/registration-token-not-registered" } })) };
    },
  };
  const sent = await sendToDevices({ db, messaging, logger }, "alice", "sync", {});
  assert.deepEqual(sent.removed, []);
  assert.equal(db.documents.get("accounts/alice/assistantDevices/d1").fcmToken, "new");
});

"use strict";

// Data-only FCM messages to the account's registered phones (docs/ASSISTANT_PROTOCOL.md "Push
// messages"). Messages are hints: the phone re-reads Firestore before acting, so they carry no
// settings or event data.

const { readDevices, refs } = require("./assistant-data");
const { logEvent } = require("./assistant-log");

const TTL_MS = { sync: 10 * 60 * 1000, publish: 2 * 60 * 1000, ping: 2 * 60 * 1000, state: 60 * 60 * 1000 };
// Tokens FCM will never accept again; their device documents are removed.
const PERMANENT_ERRORS = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

const deviceName = (device) => (typeof device.deviceName === "string" && device.deviceName ? device.deviceName : "your phone");

/**
 * Sends `{type, ...data}` to every device of `uid` that has an FCM token. Returns which devices it
 * reached, which failed (with `errors[deviceId]` = FCM error code) and which cannot receive
 * messages (no token, e.g. iOS for now).
 */
async function sendToDevices({ db, messaging, logger }, uid, type, data = {}, devices = null) {
  const list = devices ?? await readDevices(db, uid);
  const withToken = list.filter((device) => typeof device.fcmToken === "string" && device.fcmToken.length > 0);
  const result = { sent: [], failed: [], removed: [], errors: {}, noToken: list.filter((device) => !withToken.includes(device)) };
  if (withToken.length === 0) return result;
  const payload = Object.fromEntries(Object.entries({ type, ...data }).map(([key, value]) => [key, String(value)]));
  const responses = await messaging.sendEach(withToken.map((device) => ({
    token: device.fcmToken,
    data: payload,
    android: { priority: "high", ttl: TTL_MS[type] ?? 60_000 },
  })));
  await Promise.all(responses.responses.map(async (response, index) => {
    const device = withToken[index];
    if (response.success) {
      result.sent.push(device);
      return;
    }
    result.failed.push(device);
    const code = response.error?.code ?? "unknown";
    result.errors[device.id] = code;
    if (PERMANENT_ERRORS.has(code)) {
      result.removed.push(device);
      await refs.devices(db, uid).doc(device.id).delete();
      logEvent(logger, "info", "push.invalid_token_removed", { uid, deviceId: device.id, type, errorCode: code });
    } else logEvent(logger, "warn", "push.failed", { uid, deviceId: device.id, type, errorCode: code });
  }));
  return result;
}

/** Stand-in for the emulator and tests: records messages instead of sending them. */
function createRecordingMessaging(sent = []) {
  return {
    sent,
    async sendEach(messages) {
      sent.push(...messages);
      return { responses: messages.map(() => ({ success: true })) };
    },
  };
}

module.exports = { PERMANENT_ERRORS, createRecordingMessaging, deviceName, sendToDevices };

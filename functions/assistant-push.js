"use strict";

// Data-only FCM messages to the account's registered phones (docs/ASSISTANT_PROTOCOL.md "Push
// messages"). Messages are hints: the phone re-reads Firestore before acting, so they carry no
// settings or event data.

const { MAX_DEVICES, readDevices, refs } = require("./assistant-data");
const { logEvent } = require("./assistant-log");
const { cleanText } = require("./assistant-snapshot");

const TTL_MS = { sync: 10 * 60 * 1000, publish: 2 * 60 * 1000, ping: 2 * 60 * 1000, state: 60 * 60 * 1000 };
// Tokens FCM will never accept again; their device documents are removed.
const PERMANENT_ERRORS = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

const deviceName = (device) => cleanText(device.deviceName, 100) || "your phone";

/** Deletes a device whose token FCM rejected for good, unless the phone has registered a new token since. */
async function removeDevice(db, uid, deviceId, failedToken) {
  const ref = refs.devices(db, uid).doc(deviceId);
  return db.runTransaction(async (transaction) => {
    const doc = await transaction.get(ref);
    if (!doc.exists || doc.data().fcmToken !== failedToken) return false;
    transaction.delete(ref);
    return true;
  });
}

/**
 * Sends `{type, ...data}` to the devices of `uid` that have an FCM token (at most MAX_DEVICES).
 * Returns which devices it reached, which failed (with `errors[deviceId]` = FCM error code) and
 * which cannot receive messages (no token, e.g. iOS for now).
 */
async function sendToDevices({ db, messaging, logger }, uid, type, data = {}, devices = null) {
  const list = (devices ?? await readDevices(db, uid)).slice(0, MAX_DEVICES);
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
    if (PERMANENT_ERRORS.has(code) && await removeDevice(db, uid, device.id, device.fcmToken)) {
      result.removed.push(device);
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

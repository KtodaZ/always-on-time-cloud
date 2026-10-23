"use strict";

// Hints to the account's registered phones (docs/ASSISTANT_PROTOCOL.md "Push messages"): data-only
// FCM messages to Android, APNs alert pushes to iPhones. Messages are hints: the phone re-reads
// the account before acting, so they carry no uid, settings or event data.

const { MAX_DEVICES, readDevices, refs } = require("./assistant-data");
const { logEvent } = require("./assistant-log");
const { cleanText } = require("./assistant-snapshot");
const { ApnsConfigError, MAX_PAYLOAD_BYTES, PAYLOAD_VERSION, SYNC_COLLAPSE_ID } = require("./ios-push-apns");

const TTL_MS = { sync: 10 * 60 * 1000, publish: 2 * 60 * 1000, ping: 2 * 60 * 1000, state: 60 * 60 * 1000 };
// Tokens FCM will never accept again; their device documents are removed.
const PERMANENT_ERRORS = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);
// APNs answers for a token that will never work again (status 410, or 400 with these reasons).
const PERMANENT_APNS_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic"]);
const APNS_TOKEN = /^[0-9a-f]{64,200}$/;
const APNS_ENVIRONMENTS = new Set(["development", "production"]);

// The notification category iPhones register for assistant changes with an Undo action.
const CHANGE_CATEGORY = "AOT_ASSISTANT_CHANGE";
const PING_COLLAPSE_ID = "aot-assistant-ping";
const QUIET_ALERT = { title: "Keeping your alarms up to date", body: "Checking for assistant changes." };
const CHANGE_ALERT = { title: "An assistant changed your alarms", body: "Open Always On Time to review or undo." };

const deviceName = (device) => cleanText(device.deviceName, 100) || "your phone";

const hasFcmToken = (device) => typeof device.fcmToken === "string" && device.fcmToken.length > 0;
/** An iPhone with a usable APNs registration (the rules allow these fields on iOS only). */
const hasApnsToken = (device) => device.platform === "ios"
  && typeof device.apnsToken === "string" && APNS_TOKEN.test(device.apnsToken)
  && APNS_ENVIRONMENTS.has(device.apnsEnvironment);

/** Whether the server can send this device push messages (FCM or APNs). */
const canReceive = (device) => hasApnsToken(device) || hasFcmToken(device);

/** Deletes a device whose push token was rejected for good, unless the phone has registered a new token since. */
async function removeDevice(db, uid, deviceId, field, failedToken) {
  const ref = refs.devices(db, uid).doc(deviceId);
  return db.runTransaction(async (transaction) => {
    const doc = await transaction.get(ref);
    if (!doc.exists || doc.data()[field] !== failedToken) return false;
    transaction.delete(ref);
    return true;
  });
}

const assistantLabel = (value) => cleanText(value, 60) || "Your assistant";

/**
 * The APNs request for one iPhone: `{headers, body}` for the transport (it adds the topic and an
 * apns-id). Every push is a mutable alert so the notification service extension runs, including
 * after force quit and in Low Power Mode, and every push shows a notification: the quiet ones share
 * the relay's `aot-sync` entry, a change that could stop alarms gets its own entry with Undo.
 */
function buildAssistantApnsRequest({ type, data = {}, deviceId, at, alert = null, assistant = null }) {
  const aot = { v: PAYLOAD_VERSION, kind: "assistant", type, at, deviceId };
  let aps;
  let collapseId = SYNC_COLLAPSE_ID;
  if (type === "ping") {
    const name = assistantLabel(data.assistant);
    aps = {
      alert: { title: "Always On Time is connected", body: `${name} can reach this iPhone.` },
      "mutable-content": 1,
      "interruption-level": "active",
    };
    Object.assign(aot, { pingId: String(data.pingId), assistant: name });
    collapseId = PING_COLLAPSE_ID;
  } else if (type === "sync" && alert) {
    aps = { alert: { ...CHANGE_ALERT }, "mutable-content": 1, "interruption-level": "active", category: CHANGE_CATEGORY };
    Object.assign(aot, { changeId: String(data.changeId), alert: String(alert), assistant: assistantLabel(assistant) });
    collapseId = `aot-change-${data.changeId}`;
  } else if (type === "sync" || type === "publish") {
    aps = { alert: { ...QUIET_ALERT }, "mutable-content": 1, "interruption-level": "passive" };
    if (type === "sync") aot.changeId = String(data.changeId);
    else aot.requestId = String(data.requestId);
  } else {
    throw new TypeError(`no APNs push for ${type}`);
  }
  const body = JSON.stringify({ aps, aot });
  if (Buffer.byteLength(body, "utf8") > MAX_PAYLOAD_BYTES) throw new TypeError("APNs payload exceeds 4 KB");
  return {
    headers: {
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": collapseId,
      "apns-expiration": String(Math.floor((at + (TTL_MS[type] ?? 60_000)) / 1000)),
    },
    body,
  };
}

/**
 * Sends `{type, ...data}` to the devices of `uid` (at most MAX_DEVICES): FCM to devices with an FCM
 * token, APNs to iPhones with an APNs registration. iPhones get no `state` message (the app re-reads
 * the connection state when it opens), so they are `skipped` for it. `options.alert` and
 * `options.assistant` mark a `sync` for a change that could stop alarms (assistant-settings.js
 * changeAlert); iPhones then show it with Undo. `apns` is the APNs transport ({send}); without one,
 * or when it isn't configured, iPhones fail with `apns:unconfigured` and FCM is unaffected.
 * Failures are logged under `logId` (the account's log pseudonym), never the uid.
 * Returns which devices it reached, which failed (with `errors[deviceId]` = FCM error code or
 * `apns:<reason>`), which were skipped and which cannot receive messages (no push token).
 */
async function sendToDevices({ db, messaging, apns = null, logger, logId = null, now = Date.now }, uid, type, data = {}, devices = null, options = {}) {
  const list = (devices ?? await readDevices(db, uid)).slice(0, MAX_DEVICES);
  const iphones = list.filter(hasApnsToken);
  const withToken = list.filter((device) => !iphones.includes(device) && hasFcmToken(device));
  const result = {
    sent: [], failed: [], removed: [], errors: {}, skipped: [],
    noToken: list.filter((device) => !iphones.includes(device) && !withToken.includes(device)),
  };
  if (withToken.length === 0 && iphones.length === 0) return result;

  const fail = async (device, code, field, token, permanent) => {
    result.failed.push(device);
    result.errors[device.id] = code;
    if (permanent && await removeDevice(db, uid, device.id, field, token)) {
      result.removed.push(device);
      logEvent(logger, "info", "push.invalid_token_removed", { logId, deviceId: device.id, type, errorCode: code });
    } else logEvent(logger, "warn", "push.failed", { logId, deviceId: device.id, type, errorCode: code });
  };

  async function sendFcm() {
    if (withToken.length === 0) return;
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
      const code = response.error?.code ?? "unknown";
      await fail(device, code, "fcmToken", device.fcmToken, PERMANENT_ERRORS.has(code));
    }));
  }

  async function sendApns(device) {
    const at = now();
    const request = buildAssistantApnsRequest({ type, data, deviceId: device.id, at, alert: options.alert ?? null, assistant: options.assistant ?? null });
    let response;
    try {
      if (!apns) throw new ApnsConfigError("no APNs transport");
      response = await apns.send({ environment: device.apnsEnvironment, token: device.apnsToken, ...request });
    } catch (error) {
      await fail(device, error instanceof ApnsConfigError ? "apns:unconfigured" : "apns:unavailable", "apnsToken", device.apnsToken, false);
      return;
    }
    if (response?.status === 200) {
      result.sent.push(device);
      return;
    }
    const reason = typeof response?.reason === "string" && /^[A-Za-z]{1,64}$/.test(response.reason) ? response.reason : `status_${Number(response?.status) || 0}`;
    const permanent = response?.status === 410 || (response?.status === 400 && PERMANENT_APNS_REASONS.has(response.reason));
    await fail(device, `apns:${reason}`, "apnsToken", device.apnsToken, permanent);
  }

  if (type === "state") result.skipped.push(...iphones);
  await Promise.all([sendFcm(), ...(type === "state" ? [] : iphones.map(sendApns))]);
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

/**
 * Stand-in APNs transport for the emulator and tests: records each request (with its body parsed)
 * and answers `respond(request)` (APNs accepted, by default). `onSend(request)` sees each recorded
 * request; the emulator uses it to make pushes visible to its end-to-end test.
 */
function createRecordingApns({ sent = [], respond = () => ({ status: 200 }), onSend = null } = {}) {
  return {
    sent,
    async send(request) {
      const recorded = { ...request, payload: JSON.parse(request.body) };
      sent.push(recorded);
      if (onSend) await onSend(recorded);
      return respond(recorded);
    },
  };
}

module.exports = {
  CHANGE_CATEGORY,
  PERMANENT_ERRORS,
  PING_COLLAPSE_ID,
  TTL_MS,
  buildAssistantApnsRequest,
  canReceive,
  createRecordingApns,
  createRecordingMessaging,
  deviceName,
  sendToDevices,
};

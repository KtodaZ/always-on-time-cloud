"use strict";

// Debugging lines for the assistant connector: one structured entry per action (tool call, OAuth
// step, callable, push failure), written through firebase-functions' logger so Cloud Logging
// indexes every field under jsonPayload. Phones log the same changeId, requestId, pingId and
// deviceId, so a feedback log can be matched with these entries (docs/ASSISTANT_CONNECTOR.md
// "Debugging").
//
// Only the fields below are written. Anything else a caller passes is dropped, so event titles,
// summaries, payloads, tokens, codes, redirect URIs and the Firebase uid cannot end up here by
// accident. An account is named by its logId instead: a random pseudonym kept in
// accounts/{uid}/assistant/log (assistant-data.js), which account deletion removes, so entries
// that outlive an account can no longer be tied to it.

const FIELDS = [
  "logId", "grantId", "clientId", "client", "assistant", "tool", "outcome", "reason", "durationMs",
  "changeId", "undoneChangeId", "requestId", "pingId", "recordIds", "push", "deviceId", "type",
  "errorName", "errorCode", "errorMessage", "kind", "scopes", "remaining", "connections",
  "replacedGrantIds", "revokedGrantId", "revoked", "count", "path", "status",
];
const ALLOWED = new Set(FIELDS);
const MAX_STRING = 200;

/** Strips query strings and fragments from a URL-shaped client_id; other values pass through. */
function clientIdForLog(clientId) {
  if (typeof clientId !== "string") return null;
  const cut = clientId.search(/[?#]/);
  return (cut >= 0 ? clientId.slice(0, cut) : clientId).slice(0, MAX_STRING);
}

/**
 * An error message without account identifiers: Firestore errors can quote a document path
 * (accounts/{uid}/...), and other errors could quote an email address.
 */
function scrubMessage(message) {
  return message
    .replace(/accounts\/[^/\s"'`]+/g, "accounts/{uid}")
    .replace(/[^\s@"'`<>()]+@[^\s@"'`<>()]+\.[A-Za-z]{2,}/g, "{email}");
}

/**
 * Error details that are safe to log. JSON parse errors quote the text they failed on (which can
 * be a payload), so their message is left out.
 */
function errorFields(error) {
  const fields = { errorName: error?.name ?? typeof error };
  if (error?.code !== undefined) fields.errorCode = String(error.code).slice(0, 80);
  if (!(error instanceof SyntaxError) && typeof error?.message === "string") fields.errorMessage = scrubMessage(error.message.slice(0, 1000)).slice(0, MAX_STRING);
  return fields;
}

/** Per-device outcome of an FCM send (sendToDevices' result), keyed by the phone's deviceId. */
function deliveryFields(type, sent) {
  if (!sent) return undefined;
  const devices = [
    ...sent.sent.map((device) => ({ deviceId: device.id, result: "sent" })),
    ...sent.failed.map((device) => ({
      deviceId: device.id,
      result: sent.removed.includes(device) ? "removed" : "failed",
      ...(sent.errors?.[device.id] ? { errorCode: sent.errors[device.id] } : {}),
    })),
    ...sent.noToken.map((device) => ({ deviceId: device.id, result: "noToken" })),
  ];
  return { type, ...(sent.limited ? { limited: true } : {}), devices };
}

/**
 * Writes `Assistant <event>` with the allowed fields. `level` is info, warn or error. Never throws:
 * logging must not break the action it describes.
 */
function logEvent(logger, level, event, fields = {}) {
  try {
    const entry = { assistantEvent: event };
    for (const [key, value] of Object.entries(fields)) {
      if (!ALLOWED.has(key) || value === undefined) continue;
      entry[key] = typeof value === "string" ? value.slice(0, MAX_STRING) : value;
    }
    const detail = [entry.tool, entry.outcome].filter(Boolean).join(" ");
    const write = logger?.[level] ?? logger?.info;
    write?.call(logger, `Assistant ${event}${detail ? ` ${detail}` : ""}`, entry);
  } catch {
    // Ignore: a broken logger must not fail a tool call.
  }
}

module.exports = { FIELDS, clientIdForLog, deliveryFields, errorFields, logEvent, scrubMessage };

"use strict";

// assistantDeviceApi: what an iPhone's notification service extension calls when an assistant push
// arrives (docs/ASSISTANT_PROTOCOL.md "Device API"). The extension has no Firebase sign-in; it
// holds a per-device key whose SHA-256 the app wrote into its device document
// (`deviceKeyHash`). The key can only record this device's test ping, replace this device's
// snapshot and read the values the connector wrote, and it stops working when the device document
// is deleted (disconnect, sign-out, account deletion).

const { createHash, timingSafeEqual } = require("node:crypto");

const { FieldValue } = require("firebase-admin/firestore");

const { MAX_SNAPSHOT_CHARS, isChangeId, refs, toMillis } = require("./assistant-data");
const { LIMITS, clientKeys, consume, createInstanceLimiters } = require("./assistant-limits");
const { errorFields, logEvent } = require("./assistant-log");

// A snapshot payload of MAX_SNAPSHOT_CHARS grows when JSON-escaped inside the request body.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const PAGE_SIZE = 50;
// A page never ends inside a millisecond, so one millisecond holding more than a page (one commit
// writing many records) is returned whole, up to this many values.
const MAX_BUCKET = 1000;
const MAX_PING_ID = 64;
const MAX_REQUEST_ID = 64;
// Firestore timestamps end with the year 9999.
const MAX_SINCE = 253_402_300_799_998;

const UID = /^[A-Za-z0-9:_-]{1,128}$/;
// Firestore reserves document IDs of the form __x__; such a uid would fail as a server error.
const RESERVED_ID = /^__.*__$/;
const DEVICE_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DEVICE_KEY = /^Bearer ([A-Za-z0-9_-]{43})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const ROUTES = {
  "/v1/ping": { method: "POST", name: "ping" },
  "/v1/snapshot": { method: "PUT", name: "snapshot" },
  "/v1/sync": { method: "POST", name: "sync" },
};

class HttpError extends Error {
  constructor(status, message, reason = message) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function sameHash(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !SHA256_HEX.test(left) || !SHA256_HEX.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function send(res, status, value = null, headers = {}) {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  for (const [name, header] of Object.entries(headers)) res.setHeader(name, header);
  if (value !== null) res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(value === null ? "" : JSON.stringify(value));
}

function header(req, name) {
  const value = req.headers?.[name];
  return typeof value === "string" ? value : Array.isArray(value) ? String(value[0] ?? "") : "";
}

/** The route for a path, with or without the function name Cloud Functions may leave on it. */
function route(req) {
  const pathname = new URL(req.originalUrl ?? req.url ?? "/", "https://functions.invalid").pathname;
  return ROUTES[pathname.replace(/^\/assistantDeviceApi(?=\/)/, "")] ?? null;
}

/** The JSON body, measured on the raw bytes when available so the size limit is exact. */
function readBody(req) {
  const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody
    : Buffer.isBuffer(req.body) ? req.body
      : typeof req.body === "string" ? Buffer.from(req.body, "utf8")
        : null;
  let body = req.body;
  if (raw) {
    if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new HttpError(400, "invalid JSON body");
    }
  } else if (body && typeof body === "object" && Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES) {
    throw new HttpError(413, "request body too large");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "JSON object required");
  return body;
}

/** Every object is strict: a missing required field or an unknown one is a 400. */
function requireFields(body, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(body, key));
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (missing.length || unknown.length) {
    throw new HttpError(400, `fields do not match the schema (missing: ${missing.join(",") || "none"}; unknown: ${unknown.join(",") || "none"})`, "schema");
  }
}

/**
 * Why the presented key does not open this device right now, or null when it does: the device
 * document exists with this key's hash, the account is active and an assistant is connected.
 * `get(ref)` reads a document (directly or in a transaction).
 */
async function denial(db, get, uid, deviceId, keyHash) {
  const [device, account, state] = await Promise.all([
    get(refs.devices(db, uid).doc(deviceId)), get(refs.account(db, uid)), get(refs.state(db, uid)),
  ]);
  if (!device.exists) return "no_device";
  if (!sameHash(keyHash, device.data().deviceKeyHash)) return "wrong_key";
  if (!account.exists || account.data().active !== true) return "inactive_account";
  if (!state.exists || state.data().connected !== true) return "disconnected";
  return null;
}

const valueItem = (doc) => ({ id: doc.id, payload: doc.data().payload ?? null, updatedAt: toMillis(doc.data().updatedAt) });

/**
 * Values the connector wrote after `since` (epoch ms), oldest first: those whose updatedAt, in
 * whole milliseconds, is greater than `since`. Phone writes carry no updatedAt and are never
 * returned. Pages hold at most PAGE_SIZE values and end on a millisecond boundary, so calling again
 * with `since` = the last value's updatedAt continues without skipping or repeating a value.
 */
async function valuesSince(db, uid, since) {
  const values = refs.values(db, uid);
  const page = await values.where("updatedAt", ">=", new Date(since + 1)).orderBy("updatedAt").limit(PAGE_SIZE + 1).get();
  let items = page.docs.map(valueItem);
  if (items.length <= PAGE_SIZE) return { values: items, more: false };
  const boundary = items[PAGE_SIZE].updatedAt;
  items = items.slice(0, PAGE_SIZE).filter((item) => item.updatedAt < boundary);
  if (items.length === 0) {
    const bucket = await values.where("updatedAt", ">=", new Date(boundary)).where("updatedAt", "<", new Date(boundary + 1))
      .orderBy("updatedAt").limit(MAX_BUCKET).get();
    items = bucket.docs.map(valueItem);
  }
  return { values: items, more: true };
}

/** One activity entry as the extension needs it: never its summary or the records' payloads. */
async function changeInfo(db, uid, changeId) {
  if (!changeId) return null;
  const doc = await refs.activity(db, uid).doc(changeId).get();
  if (!doc.exists) return null;
  const data = doc.data();
  return {
    changeId,
    assistant: typeof data.assistant === "string" ? data.assistant : null,
    alert: typeof data.alert === "string" ? data.alert : null,
    writtenAt: toMillis(data.writtenAt),
    undoneAt: toMillis(data.undoneAt),
    recordIds: data.records && typeof data.records === "object" ? Object.keys(data.records).sort() : [],
  };
}

/**
 * Builds the request handler. `deps`: db, logger, now, limiters (in-memory failure budgets),
 * serverTimestamp (FieldValue.serverTimestamp by default).
 */
function createDeviceApi(deps) {
  const { db, logger, now = Date.now } = deps;
  const limiters = deps.limiters ?? createInstanceLimiters();
  const serverTimestamp = deps.serverTimestamp ?? (() => FieldValue.serverTimestamp());

  /** Runs `write(transaction)` only while the key still opens the device (checked in the same transaction). */
  async function writeIfAllowed(uid, deviceId, keyHash, write) {
    const reason = await db.runTransaction(async (transaction) => {
      const denied = await denial(db, (ref) => transaction.get(ref), uid, deviceId, keyHash);
      if (!denied) write(transaction);
      return denied;
    });
    if (reason) throw new HttpError(401, "unauthorized", reason);
  }

  async function ping(auth, body) {
    requireFields(body, ["uid", "deviceId", "pingId"]);
    if (typeof body.pingId !== "string" || body.pingId.length === 0 || body.pingId.length > MAX_PING_ID) {
      throw new HttpError(400, `pingId must be a string of 1-${MAX_PING_ID} characters`, "invalid_ping_id");
    }
    await writeIfAllowed(auth.uid, auth.deviceId, auth.keyHash, (transaction) => {
      transaction.update(refs.devices(db, auth.uid).doc(auth.deviceId), {
        lastPing: { id: body.pingId, receivedAt: serverTimestamp() },
        updatedAt: serverTimestamp(),
      });
    });
    return { status: 204, fields: { pingId: body.pingId } };
  }

  async function snapshot(auth, body) {
    requireFields(body, ["uid", "deviceId", "payload"], ["requestId"]);
    if (typeof body.payload !== "string" || body.payload.length > MAX_SNAPSHOT_CHARS) {
      throw new HttpError(400, `payload must be a string of at most ${MAX_SNAPSHOT_CHARS} characters`, "invalid_payload");
    }
    const requestId = body.requestId ?? undefined;
    if (requestId !== undefined && (typeof requestId !== "string" || requestId.length > MAX_REQUEST_ID)) {
      throw new HttpError(400, `requestId must be a string of at most ${MAX_REQUEST_ID} characters`, "invalid_request_id");
    }
    // The same document a phone writes itself (firestore.rules isValidSnapshot).
    const document = { schemaVersion: 1, publishedAt: serverTimestamp(), ...(requestId !== undefined ? { requestId } : {}), payload: body.payload };
    try {
      await writeIfAllowed(auth.uid, auth.deviceId, auth.keyHash, (transaction) => {
        transaction.set(refs.snapshots(db, auth.uid).doc(auth.deviceId), document);
      });
    } catch (error) {
      // Firestore refuses documents over 1 MiB (a payload with many multi-byte characters).
      if ((error?.code === 3 || error?.code === "invalid-argument") && /size|too large|exceeds/i.test(String(error.message))) {
        throw new HttpError(413, "snapshot too large", "too_large");
      }
      throw error;
    }
    return { status: 204, fields: requestId ? { requestId } : {} };
  }

  async function sync(auth, body) {
    requireFields(body, ["uid", "deviceId", "since"], ["changeId"]);
    if (!Number.isSafeInteger(body.since) || body.since < 0 || body.since > MAX_SINCE) {
      throw new HttpError(400, "since must be epoch milliseconds (a non-negative integer)", "invalid_since");
    }
    const changeId = body.changeId ?? null;
    if (changeId !== null && !isChangeId(changeId)) throw new HttpError(400, "changeId is not a change id", "invalid_change_id");
    const [change, page] = await Promise.all([changeInfo(db, auth.uid, changeId), valuesSince(db, auth.uid, body.since)]);
    return {
      status: 200,
      body: { change, values: page.values, more: page.more },
      fields: { ...(changeId ? { changeId } : {}), count: page.values.length },
    };
  }

  const handlers = { ping, snapshot, sync };

  return async function handler(req, res) {
    const started = now();
    const target = route(req);
    if (!target) return send(res, 404, { error: "not found" });
    if (String(req.method ?? "").toUpperCase() !== target.method) {
      return send(res, 405, { error: "method not allowed" }, { Allow: target.method });
    }
    const caller = clientKeys(req);
    const log = (level, outcome, fields = {}) => logEvent(logger, level, "device_api", {
      path: target.name, outcome, durationMs: now() - started, ...fields,
    });
    // A network that used up its failure budget is refused before the body is read or any
    // document is fetched. Only the per-caller budget is checked up front: the overall one is
    // shared by every direct caller, so checking it first would let a flood lock out real iPhones.
    if (limiters.unauthorized.exceeded(caller.client, now())) {
      return send(res, 429, { error: "too many failed requests" }, { "Retry-After": "60" });
    }
    let auth = null;
    try {
      const body = readBody(req);
      const key = DEVICE_KEY.exec(header(req, "authorization"))?.[1] ?? null;
      const { uid, deviceId } = body;
      if (!key || typeof uid !== "string" || !UID.test(uid) || RESERVED_ID.test(uid) || typeof deviceId !== "string" || !DEVICE_ID.test(deviceId)) {
        throw new HttpError(401, "unauthorized", "malformed");
      }
      const keyHash = sha256Hex(key);
      const reason = await denial(db, (ref) => ref.get(), uid, deviceId, keyHash);
      if (reason) throw new HttpError(401, "unauthorized", reason);
      // The account's log pseudonym, read only once the key works, for matching these lines with
      // the connector's (never the uid).
      const logDoc = await refs.log(db, uid).get();
      auth = { uid, deviceId, keyHash, logId: logDoc.exists && typeof logDoc.data().logId === "string" ? logDoc.data().logId : null };
      if (!(await consume(db, `device|${uid}|${deviceId}`, LIMITS.device, now()))) {
        throw new HttpError(429, "rate limit exceeded", "rate_limited");
      }
      const out = await handlers[target.name](auth, body);
      log("info", "ok", { logId: auth.logId, deviceId, status: out.status, ...out.fields });
      return send(res, out.status, out.body ?? null);
    } catch (error) {
      if (!(error instanceof HttpError)) {
        log("error", "unexpected_error", { logId: auth?.logId, deviceId: auth?.deviceId, status: 500, ...errorFields(error) });
        return send(res, 500, { error: "server error" });
      }
      if (!auth) {
        // Failures before the key is accepted (unreadable bodies, failed keys) are counted per
        // caller and overall; past the budget the answer is 429 and nothing is logged, so a flood
        // stays cheap.
        const time = now();
        const counted = [limiters.unauthorized(caller.client, time), limiters.unauthorizedGlobal(caller.scope, time)];
        if (!counted.every(Boolean)) return send(res, 429, { error: "too many failed requests" }, { "Retry-After": "60" });
        log("info", error.status === 401 ? "unauthorized" : "refused", { reason: error.reason, status: error.status });
        return send(res, error.status, { error: error.status === 401 ? "unauthorized" : error.message });
      }
      log(error.status === 429 ? "warn" : "info", "refused", { logId: auth?.logId, deviceId: auth?.deviceId, reason: error.reason, status: error.status });
      return send(res, error.status, { error: error.message }, error.status === 429 ? { "Retry-After": "600" } : {});
    }
  };
}

module.exports = { MAX_BODY_BYTES, PAGE_SIZE, createDeviceApi, valuesSince };

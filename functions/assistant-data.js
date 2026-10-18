"use strict";

// Firestore paths and helpers for the assistant connector (docs/ASSISTANT_PROTOCOL.md). Every
// account path takes the uid from a verified token; nothing here accepts a path from a caller.

const { randomBytes } = require("node:crypto");

const { FieldValue } = require("firebase-admin/firestore");

const { RecordError, encodePayload, samePayload } = require("./assistant-records");

const COLLECTIONS = {
  clients: "oauthClients",
  requests: "oauthRequests",
  codes: "oauthCodes",
  grants: "oauthGrants",
  tokens: "oauthTokens",
  usage: "assistantUsage",
  limits: "assistantRateLimits",
};

const DAY_MS = 24 * 60 * 60 * 1000;
// How long activity entries (and so undo) last, how far ahead phones share events, and how much
// alarm history the account keeps (the app's ACCOUNT_HISTORY_DAYS).
const UNDO_DAYS = 30;
const ACTIVITY_TTL_MS = UNDO_DAYS * DAY_MS;
const SNAPSHOT_WINDOW_DAYS = 30;
const HISTORY_DAYS = 14;
// Bounds on what one call reads or messages, whatever a misbehaving client writes.
const MAX_SNAPSHOTS = 5;
const MAX_DEVICES = 10;

// changeIds are "ch_" + 12 random bytes in base64url (16 characters, no padding).
const CHANGE_ID_PREFIX = "ch_";
const CHANGE_ID_BYTES = 12;
const CHANGE_ID_PATTERN = new RegExp(`^${CHANGE_ID_PREFIX}[A-Za-z0-9_-]{${Math.ceil((CHANGE_ID_BYTES * 4) / 3)}}$`);
const isChangeId = (value) => typeof value === "string" && CHANGE_ID_PATTERN.test(value);

const account = (db, uid) => {
  if (typeof uid !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(uid)) throw new Error("invalid uid");
  return db.collection("accounts").doc(uid);
};

const refs = {
  account,
  state: (db, uid) => account(db, uid).collection("assistant").doc("state"),
  // Server-only (clients can read only assistant/state): the account's logId.
  log: (db, uid) => account(db, uid).collection("assistant").doc("log"),
  devices: (db, uid) => account(db, uid).collection("assistantDevices"),
  snapshots: (db, uid) => account(db, uid).collection("assistantSnapshots"),
  activity: (db, uid) => account(db, uid).collection("assistantActivity"),
  values: (db, uid) => account(db, uid).collection("values"),
  history: (db, uid) => account(db, uid).collection("history"),
};

/** Firestore Timestamp, Date or epoch ms as epoch ms (null otherwise). */
function toMillis(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === "function") return value.toMillis();
  return null;
}

const randomId = (prefix, bytes = 16) => `${prefix}${randomBytes(bytes).toString("base64url")}`;

// logIds are "log_" + 12 random bytes in base64url. Debugging log entries name the account by its
// logId, never its uid (assistant-log.js); deleting accounts/{uid}/assistant/log with the account
// leaves nothing that ties those entries back to it.
const LOG_ID_PREFIX = "log_";
const LOG_ID_BYTES = 12;

/**
 * Inside `transaction`, returns the account's logId, creating it if needed, or null when the
 * account isn't active (deleted or never set up), so a request racing account deletion can't
 * recreate it. Reads two documents, so call it after the transaction's other reads and before its
 * writes.
 */
async function ensureLogId(transaction, db, uid, now = Date.now()) {
  const [root, log] = await Promise.all([transaction.get(refs.account(db, uid)), transaction.get(refs.log(db, uid))]);
  if (!root.exists || root.data().active !== true) return null;
  const existing = log.exists ? log.data().logId : null;
  if (typeof existing === "string" && existing.startsWith(LOG_ID_PREFIX)) return existing;
  const logId = randomId(LOG_ID_PREFIX, LOG_ID_BYTES);
  transaction.set(refs.log(db, uid), { logId, createdAt: new Date(now) });
  return logId;
}

/** The account's logId if it has one, else null. Never creates one and never throws. */
async function readLogId(db, uid) {
  try {
    const doc = await refs.log(db, uid).get();
    return doc.exists && typeof doc.data().logId === "string" ? doc.data().logId : null;
  } catch {
    return null;
  }
}

/** The account's most recently updated phones (at most MAX_DEVICES; the rules require updatedAt). */
async function readDevices(db, uid) {
  const page = await refs.devices(db, uid).orderBy("updatedAt", "desc").limit(MAX_DEVICES).get();
  return page.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

// The largest snapshot payload the rules accept (firestore.rules isValidSnapshot), which the phone
// trims its snapshot to fit. A stored payload over it is treated as unreadable and never parsed.
const MAX_SNAPSHOT_CHARS = 800000;

/** A snapshot's payload string parsed into an object, or null when missing, oversized or not a JSON object. */
function parseSnapshotPayload(text) {
  if (typeof text !== "string" || text.length > MAX_SNAPSHOT_CHARS) return null;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
}

function snapshotFrom(doc) {
  const data = doc.data();
  return {
    deviceId: doc.id,
    publishedAt: toMillis(data.publishedAt),
    requestId: typeof data.requestId === "string" ? data.requestId : null,
    payload: parseSnapshotPayload(data.payload),
  };
}

/**
 * The most recently published snapshot, with its payload parsed (null when it can't be read), or
 * null when there is none. Only that one document is read and parsed.
 */
async function readLatestSnapshot(db, uid) {
  const page = await refs.snapshots(db, uid).orderBy("publishedAt", "desc").limit(1).get();
  return page.docs[0] ? snapshotFrom(page.docs[0]) : null;
}

/** One phone's snapshot, parsed like readLatestSnapshot, or null when it has none. */
async function readSnapshot(db, uid, deviceId) {
  const doc = await refs.snapshots(db, uid).doc(deviceId).get();
  return doc.exists ? snapshotFrom(doc) : null;
}

/**
 * The latest snapshots (at most MAX_SNAPSHOTS), newest first, without their payloads: deviceId,
 * publishedAt and requestId only. Cheap enough to poll.
 */
async function readSnapshotTimes(db, uid) {
  const page = await refs.snapshots(db, uid).orderBy("publishedAt", "desc").limit(MAX_SNAPSHOTS).select("publishedAt", "requestId").get();
  return page.docs.map((doc) => ({
    deviceId: doc.id,
    publishedAt: toMillis(doc.data().publishedAt),
    requestId: typeof doc.data().requestId === "string" ? doc.data().requestId : null,
  })).filter((item) => item.publishedAt !== null);
}

// The payload's top-level "valuesAppliedThrough" (docs/ASSISTANT_PROTOCOL.md "Snapshot"). Inside a
// JSON string every quote is escaped, so this can only match an object key.
const APPLIED_THROUGH = /"valuesAppliedThrough"\s*:\s*(\d{1,16})\s*[,}]/;

/**
 * One snapshot's valuesAppliedThrough (0 when it has none), found without parsing the payload, or
 * null when the snapshot is gone or its payload is unreadable.
 */
async function readAppliedThrough(db, uid, deviceId) {
  const doc = await refs.snapshots(db, uid).doc(deviceId).get();
  const text = doc.exists ? doc.data().payload : null;
  if (typeof text !== "string" || text.length > MAX_SNAPSHOT_CHARS) return null;
  const match = APPLIED_THROUGH.exec(text);
  return match ? Number(match[1]) : 0;
}

/** Current payload strings for the given record ids (missing documents are null). */
async function readValues(db, uid, recordIds) {
  const collection = refs.values(db, uid);
  const docs = await Promise.all(recordIds.map((id) => collection.doc(id).get()));
  return Object.fromEntries(docs.map((doc, index) => [recordIds[index], doc.exists ? doc.data().payload ?? null : null]));
}

/** Deletes every document of a flat collection in pages (works on the emulator, production and tests). */
async function deleteCollection(db, collection) {
  let deleted = 0;
  for (;;) {
    const page = await collection.limit(400).get();
    if (page.empty) return deleted;
    const batch = db.batch();
    page.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += page.size;
  }
}

/**
 * Removes what an assistant connection created in an account (snapshots, devices, activity). With
 * `onlyIfDisconnected`, it stops as soon as assistant/state says connected again (an assistant
 * connected while a revocation was cleaning up), re-checking before each collection, and returns
 * false.
 */
async function deleteConnectorData(db, uid, { onlyIfDisconnected = false } = {}) {
  for (const collection of [refs.snapshots(db, uid), refs.devices(db, uid), refs.activity(db, uid)]) {
    if (onlyIfDisconnected) {
      const state = await refs.state(db, uid).get();
      if (state.exists && state.data().connected === true) return false;
    }
    await deleteCollection(db, collection);
  }
  return true;
}

// Firestore error codes for a failed write precondition: the document changed or appeared since
// it was read, so the change is rebuilt from fresh data.
const CONFLICT_CODES = new Set([6, 9, "already-exists", "failed-precondition"]);
const MAX_ATTEMPTS = 5;

/**
 * Writes account values for an assistant change and its activity entry in one atomic commit.
 *
 * `build(current, read)` receives the current payloads of `recordIds` (null when missing) and
 * returns the new value for each record to change (any JSON value; `null` clears). It may read
 * more documents with `read(ref)` and throw to abort. Values are validated and written in the
 * canonical encoding (assistant-records.js). Records whose value would not change in meaning are
 * skipped; if nothing changes, nothing is written and `changeId` is null. `alert(records, current)`
 * names the activity's alert, if any. `afterWrite(batch, read)` may add writes to the same commit.
 * Records read but not returned by `build` are left alone.
 *
 * Every write is guarded by the update time it was read at (or must create the document), so a
 * concurrent change makes the commit fail and the change is rebuilt. The account document is
 * guarded the same way and must be active, so a change can't land once account deletion started.
 * The activity's `writtenAt` and the values' `updatedAt` are the same server timestamp (the commit
 * time), which phones report back.
 */
async function recordChange(db, uid, { recordIds, build, assistant, tool, summary, now, afterWrite, alert }) {
  const values = refs.values(db, uid);
  for (let attempt = 1; ; attempt += 1) {
    const snapshots = new Map();
    const read = async (ref) => {
      const doc = await ref.get();
      snapshots.set(ref.path, doc);
      return doc;
    };
    const [root, ...docs] = await Promise.all([refs.account(db, uid).get(), ...recordIds.map((id) => read(values.doc(id)))]);
    if (!root.exists || root.data().active !== true) throw new RecordError("the account is no longer active");
    const current = Object.fromEntries(docs.map((doc, index) => [recordIds[index], doc.exists ? doc.data().payload ?? null : null]));
    const next = await build(current, read);
    const records = {};
    for (const [recordId, value] of Object.entries(next)) {
      if (!recordIds.includes(recordId)) throw new Error(`unexpected record ${recordId}`);
      const payload = encodePayload(recordId, value);
      if (samePayload(recordId, current[recordId], payload)) continue;
      records[recordId] = { before: current[recordId], after: payload };
    }
    if (Object.keys(records).length === 0) return { changeId: null, records, alert: null };

    const changeId = randomId(CHANGE_ID_PREFIX, CHANGE_ID_BYTES);
    const activityRef = refs.activity(db, uid).doc(changeId);
    const changeAlert = alert ? alert(records, current) : null;
    const batch = db.batch();
    batch.create(activityRef, {
      assistant: String(assistant ?? "Assistant").slice(0, 60),
      tool,
      summary: String(summary).slice(0, 500),
      records,
      ...(changeAlert ? { alert: changeAlert } : {}),
      // Every server timestamp in one commit resolves to the commit time, so this equals the
      // values' updatedAt below, which phones report back.
      writtenAt: FieldValue.serverTimestamp(),
      expiresAt: new Date(now + ACTIVITY_TTL_MS),
    });
    for (const [recordId, { after }] of Object.entries(records)) {
      const doc = snapshots.get(values.doc(recordId).path);
      // Android's Firestore SDK doesn't expose updateTime, so phones report this field back as
      // valuesAppliedThrough. Phone writes replace it.
      const value = { payload: after, updatedAt: FieldValue.serverTimestamp() };
      if (doc.exists) batch.update(doc.ref, value, { lastUpdateTime: doc.updateTime });
      else batch.create(doc.ref, value);
    }
    if (afterWrite) afterWrite(batch, (ref) => snapshots.get(ref.path));
    // Commit only while the account is still the active one read above, as ensureLogId does: if
    // account deletion has written its tombstone since, this fails and the retry stops the change.
    batch.update(root.ref, { active: true }, { lastUpdateTime: root.updateTime });
    try {
      await batch.commit();
    } catch (error) {
      if (CONFLICT_CODES.has(error?.code) && attempt < MAX_ATTEMPTS) continue;
      throw error;
    }
    // The commit's writeTime isn't returned as writtenAt: it can differ from the server timestamps
    // stored in it (the emulator's do by milliseconds). confirm_change reads the stored writtenAt.
    return { changeId, records, alert: changeAlert };
  }
}

module.exports = {
  ACTIVITY_TTL_MS,
  CHANGE_ID_PATTERN,
  COLLECTIONS,
  DAY_MS,
  HISTORY_DAYS,
  MAX_DEVICES,
  MAX_SNAPSHOTS,
  MAX_SNAPSHOT_CHARS,
  SNAPSHOT_WINDOW_DAYS,
  UNDO_DAYS,
  deleteCollection,
  deleteConnectorData,
  ensureLogId,
  isChangeId,
  parseSnapshotPayload,
  randomId,
  readAppliedThrough,
  readDevices,
  readLatestSnapshot,
  readLogId,
  readSnapshot,
  readSnapshotTimes,
  readValues,
  recordChange,
  refs,
  toMillis,
};

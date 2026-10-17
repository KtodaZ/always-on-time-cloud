"use strict";

// Firestore paths and helpers for the assistant connector (docs/ASSISTANT_PROTOCOL.md). Every
// account path takes the uid from a verified token; nothing here accepts a path from a caller.

const { randomBytes } = require("node:crypto");

const { encodePayload, validatePayload } = require("./assistant-records");

/** A stored payload string to write back verbatim (validated again), e.g. when undoing. */
class RawPayload {
  constructor(payload) {
    this.payload = payload;
  }
}

const COLLECTIONS = {
  clients: "oauthClients",
  requests: "oauthRequests",
  codes: "oauthCodes",
  grants: "oauthGrants",
  tokens: "oauthTokens",
  usage: "assistantUsage",
  limits: "assistantRateLimits",
};

const ACTIVITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const account = (db, uid) => {
  if (typeof uid !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(uid)) throw new Error("invalid uid");
  return db.collection("accounts").doc(uid);
};

const refs = {
  account,
  state: (db, uid) => account(db, uid).collection("assistant").doc("state"),
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

async function readDevices(db, uid) {
  const page = await refs.devices(db, uid).get();
  return page.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

/** Every phone's latest snapshot, newest first. A payload that does not parse is reported, not thrown. */
async function readSnapshots(db, uid) {
  const page = await refs.snapshots(db, uid).get();
  const snapshots = page.docs.map((doc) => {
    const data = doc.data();
    let payload = null;
    try {
      payload = typeof data.payload === "string" ? JSON.parse(data.payload) : null;
    } catch {
      payload = null;
    }
    return {
      deviceId: doc.id,
      publishedAt: toMillis(data.publishedAt),
      requestId: data.requestId ?? null,
      payload: payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null,
    };
  });
  return snapshots.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
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

/** Removes what an assistant connection created in an account (snapshots, devices, activity). */
async function deleteConnectorData(db, uid) {
  await deleteCollection(db, refs.snapshots(db, uid));
  await deleteCollection(db, refs.devices(db, uid));
  await deleteCollection(db, refs.activity(db, uid));
}

/**
 * Writes account values for an assistant change and its activity entry in one transaction.
 * `build(current, transaction)` receives the current payloads of `recordIds` (it may read more in
 * the transaction, and throw to abort) and returns the new payload value
 * (any JSON value, `null` clears, or a RawPayload) for each record to change. Records whose payload would not change
 * are skipped; if nothing changes, nothing is written and `changeId` is null.
 *
 * `afterWrite(transaction, serverTime)` may add writes to the same commit.
 *
 * `writtenAt` is a server timestamp in the same commit as the values, so it equals their update time.
 */
async function recordChange(db, uid, { recordIds, build, assistant, tool, summary, now, fields, afterWrite }) {
  const changeId = randomId("ch_", 12);
  const values = refs.values(db, uid);
  return db.runTransaction(async (transaction) => {
    const docs = await Promise.all(recordIds.map((id) => transaction.get(values.doc(id))));
    const current = Object.fromEntries(docs.map((doc, index) => [recordIds[index], doc.exists ? doc.data().payload ?? null : null]));
    const next = await build(current, transaction);
    const records = {};
    for (const [recordId, value] of Object.entries(next)) {
      if (!recordIds.includes(recordId)) throw new Error(`unexpected record ${recordId}`);
      let payload;
      if (value instanceof RawPayload) {
        validatePayload(recordId, value.payload);
        payload = value.payload;
      } else payload = encodePayload(recordId, value);
      if (payload === current[recordId]) continue;
      records[recordId] = { before: current[recordId], after: payload };
    }
    if (Object.keys(records).length === 0) return { changeId: null, records };
    for (const [recordId, { after }] of Object.entries(records)) transaction.set(values.doc(recordId), { payload: after });
    transaction.set(refs.activity(db, uid).doc(changeId), {
      assistant: String(assistant ?? "Assistant").slice(0, 60),
      tool,
      summary: String(summary).slice(0, 500),
      records,
      writtenAt: fields.serverTimestamp(),
      expiresAt: new Date(now + ACTIVITY_TTL_MS),
    });
    if (afterWrite) afterWrite(transaction, fields.serverTimestamp());
    return { changeId, records };
  });
}

module.exports = {
  ACTIVITY_TTL_MS,
  COLLECTIONS,
  RawPayload,
  deleteCollection,
  deleteConnectorData,
  randomId,
  readDevices,
  readSnapshots,
  readValues,
  recordChange,
  refs,
  toMillis,
};

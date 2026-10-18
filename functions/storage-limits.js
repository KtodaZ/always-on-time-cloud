"use strict";

// Caps on how much one account, or one feedback sender, can keep stored. The rules bound each
// document; these server-side cleanups bound how many documents and uploads there are.

const { MAX_DEVICES } = require("./assistant-data");

// Synced alarm history kept per account, newest by createdAt. Phones sync 14 days of it, one entry
// per alarm that rang: a few hundred per phone, about 1,400 for a very busy one.
const MAX_HISTORY_PER_ACCOUNT = 5000;
// Assistant devices and snapshots per account: the server only ever reads the newest
// MAX_DEVICES devices, and a snapshot belongs to a device.
const MAX_ASSISTANT_DEVICES = MAX_DEVICES;
const DELETE_PAGE = 400;

/**
 * Deletes the oldest documents of `collection` by `field` until at most `max` remain. Returns how
 * many it deleted. Cheap when under the cap: one count aggregation.
 */
async function keepNewest(db, collection, field, max) {
  const { count } = (await collection.count().get()).data();
  if (count <= max) return 0;
  const extra = await collection.orderBy(field, "asc").limit(count - max).get();
  for (let start = 0; start < extra.docs.length; start += DELETE_PAGE) {
    const batch = db.batch();
    extra.docs.slice(start, start + DELETE_PAGE).forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
  return extra.size;
}

const account = (db, uid) => db.collection("accounts").doc(uid);

const capHistory = (db, uid) => keepNewest(db, account(db, uid).collection("history"), "createdAt", MAX_HISTORY_PER_ACCOUNT);
const capAssistantDevices = (db, uid) => keepNewest(db, account(db, uid).collection("assistantDevices"), "updatedAt", MAX_ASSISTANT_DEVICES);
const capAssistantSnapshots = (db, uid) => keepNewest(db, account(db, uid).collection("assistantSnapshots"), "publishedAt", MAX_ASSISTANT_DEVICES);

// ---- Feedback uploads ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
// An upload no feedback document names after this long was abandoned (the app writes the document
// right after its uploads finish). Uploads up to ORPHAN_SCAN_MS old are checked on every run, so a
// few missed runs still catch everything.
const ORPHAN_AFTER_MS = 24 * HOUR_MS;
const ORPHAN_SCAN_MS = 7 * 24 * HOUR_MS;
const FEEDBACK_PATH = /^feedback\/[^/]+\/([^/]+)\/[^/]+$/;

/** Whether `feedback` (a feedback document's data, or undefined) names the object at `path`. */
function referencesUpload(feedback, path) {
  if (!feedback) return false;
  const attachments = Array.isArray(feedback.attachments) ? feedback.attachments : [];
  return attachments.some((item) => item?.path === path) || feedback.diagnosticLog?.path === path;
}

/**
 * Deletes feedback uploads that no feedback document references, once they are a day old.
 * `bucket` is a Cloud Storage bucket (getFiles with pagination). Returns {checked, deleted}.
 */
async function deleteOrphanFeedbackUploads(db, bucket, now = Date.now()) {
  const feedback = new Map();
  const lookup = async (feedbackId) => {
    if (!feedback.has(feedbackId)) {
      const doc = await db.collection("feedback").doc(feedbackId).get();
      feedback.set(feedbackId, doc.exists ? doc.data() : undefined);
    }
    return feedback.get(feedbackId);
  };
  let checked = 0;
  let deleted = 0;
  let query = { prefix: "feedback/", autoPaginate: false, maxResults: 1000 };
  while (query) {
    const [files, next] = await bucket.getFiles(query);
    for (const file of files) {
      const age = now - Date.parse(file.metadata?.timeCreated);
      if (!(age >= ORPHAN_AFTER_MS && age <= ORPHAN_SCAN_MS)) continue;
      checked += 1;
      const match = FEEDBACK_PATH.exec(file.name);
      if (match && referencesUpload(await lookup(match[1]), file.name)) continue;
      await file.delete({ ignoreNotFound: true });
      deleted += 1;
    }
    query = next;
  }
  return { checked, deleted };
}

module.exports = {
  MAX_ASSISTANT_DEVICES,
  MAX_HISTORY_PER_ACCOUNT,
  ORPHAN_AFTER_MS,
  ORPHAN_SCAN_MS,
  capAssistantDevices,
  capAssistantSnapshots,
  capHistory,
  deleteOrphanFeedbackUploads,
  keepNewest,
  referencesUpload,
};

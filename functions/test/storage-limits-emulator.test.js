"use strict";

// Runs the storage caps against the Firestore and Storage emulators (skipped unless both are set;
// the Test workflow runs it under `firebase emulators:exec --only firestore,storage`).

const assert = require("node:assert/strict");
const test = require("node:test");

const ready = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_STORAGE_EMULATOR_HOST;
const skip = ready ? false : "set FIRESTORE_EMULATOR_HOST and FIREBASE_STORAGE_EMULATOR_HOST to run against the emulators";

test("orphaned feedback uploads and extra account documents are deleted on the emulators", { skip }, async () => {
  const { initializeApp, deleteApp } = require("firebase-admin/app");
  const { getFirestore, Timestamp } = require("firebase-admin/firestore");
  const { getStorage } = require("firebase-admin/storage");
  const { MAX_ASSISTANT_DEVICES, ORPHAN_AFTER_MS, capAssistantSnapshots, capHistory, deleteOrphanFeedbackUploads } = require("../storage-limits");

  const app = initializeApp({ projectId: "demo-account-sync", storageBucket: "demo-account-sync.appspot.com" }, `storage-limits-${Date.now()}`);
  const db = getFirestore(app);
  const bucket = getStorage(app).bucket();
  const run = Date.now();
  const uid = `limits-${run}`;
  try {
    // Feedback: one referenced upload, one orphan, across more than one listing page.
    await db.collection("feedback").doc(`f-${run}`).set({ attachments: [{ id: "a1", path: `feedback/${uid}/f-${run}/a1` }] });
    for (const name of [`feedback/${uid}/f-${run}/a1`, `feedback/${uid}/f-${run}/a2`, `feedback/${uid}/g-${run}/a1`]) {
      await bucket.file(name).save(Buffer.from("png"), { contentType: "image/png" });
    }
    // Nothing is a day old yet.
    assert.equal((await deleteOrphanFeedbackUploads(db, bucket)).deleted, 0);
    const later = Date.now() + ORPHAN_AFTER_MS + 60000;
    const result = await deleteOrphanFeedbackUploads(db, bucket, later);
    assert.ok(result.deleted >= 2, JSON.stringify(result));
    const [left] = await bucket.getFiles({ prefix: `feedback/${uid}/` });
    assert.deepEqual(left.map((file) => file.name), [`feedback/${uid}/f-${run}/a1`]);

    // Account caps use count aggregations and ordered deletes.
    const account = db.collection("accounts").doc(uid);
    for (let i = 0; i < MAX_ASSISTANT_DEVICES + 2; i += 1) {
      await account.collection("assistantSnapshots").doc(`d${String(i).padStart(2, "0")}`).set({ payload: "{}", publishedAt: Timestamp.fromMillis(run - i * 1000) });
    }
    assert.equal(await capAssistantSnapshots(db, uid), 2);
    const snapshots = await account.collection("assistantSnapshots").get();
    assert.equal(snapshots.size, MAX_ASSISTANT_DEVICES);
    assert.ok(!snapshots.docs.some((doc) => ["d10", "d11"].includes(doc.id)));
    await account.collection("history").doc("a".repeat(64)).set({ payload: "{}", createdAt: run });
    assert.equal(await capHistory(db, uid), 0);
  } finally {
    await db.recursiveDelete(db.collection("accounts").doc(uid));
    await deleteApp(app);
  }
});

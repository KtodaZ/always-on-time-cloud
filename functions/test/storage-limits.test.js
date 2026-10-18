"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { FakeFirestore } = require("../testing/fake-firestore");
const {
  MAX_ASSISTANT_DEVICES, MAX_HISTORY_PER_ACCOUNT, ORPHAN_AFTER_MS, ORPHAN_SCAN_MS,
  capAssistantDevices, capAssistantSnapshots, capHistory, deleteOrphanFeedbackUploads,
} = require("../storage-limits");

const HOUR = 60 * 60 * 1000;

test("history over the per-account cap loses its oldest entries; other accounts are untouched", async () => {
  const db = new FakeFirestore();
  const now = Date.now();
  for (let i = 0; i < MAX_HISTORY_PER_ACCOUNT + 3; i += 1) {
    db.documents.set(`accounts/alice/history/${String(i).padStart(64, "0")}`, { payload: "{}", createdAt: now - i * 1000 });
  }
  db.documents.set(`accounts/bob/history/${"b".repeat(64)}`, { payload: "{}", createdAt: now - 10 * HOUR });
  assert.equal(await capHistory(db, "alice"), 3);
  const left = [...db.documents.keys()].filter((path) => path.startsWith("accounts/alice/history/"));
  assert.equal(left.length, MAX_HISTORY_PER_ACCOUNT);
  // The three oldest (largest i) went.
  for (let i = MAX_HISTORY_PER_ACCOUNT; i < MAX_HISTORY_PER_ACCOUNT + 3; i += 1) {
    assert.equal(db.documents.has(`accounts/alice/history/${String(i).padStart(64, "0")}`), false);
  }
  assert.ok(db.documents.has(`accounts/bob/history/${"b".repeat(64)}`));
  // Under the cap, nothing is deleted.
  assert.equal(await capHistory(db, "alice"), 0);
  assert.equal(await capHistory(db, "bob"), 0);
});

test("assistant devices and snapshots keep the most recently updated ten", async () => {
  const db = new FakeFirestore();
  const now = Date.now();
  for (let i = 0; i < MAX_ASSISTANT_DEVICES + 2; i += 1) {
    db.documents.set(`accounts/alice/assistantDevices/d${i}`, { platform: "android", updatedAt: new Date(now - i * HOUR) });
    db.documents.set(`accounts/alice/assistantSnapshots/d${i}`, { payload: "{}", publishedAt: new Date(now - i * HOUR) });
  }
  assert.equal(await capAssistantDevices(db, "alice"), 2);
  assert.equal(await capAssistantSnapshots(db, "alice"), 2);
  for (const collection of ["assistantDevices", "assistantSnapshots"]) {
    const ids = [...db.documents.keys()].filter((path) => path.startsWith(`accounts/alice/${collection}/`)).map((path) => path.split("/").at(-1)).sort();
    assert.deepEqual(ids, Array.from({ length: MAX_ASSISTANT_DEVICES }, (_, i) => `d${i}`).sort(), collection);
  }
});

function fakeBucket(files, pageSize = 2) {
  const deleted = [];
  return {
    deleted,
    async getFiles(query) {
      assert.equal(query.prefix, "feedback/");
      const start = query.pageToken ?? 0;
      const page = files.slice(start, start + pageSize).map((file) => ({
        name: file.name,
        metadata: { timeCreated: new Date(file.created).toISOString() },
        delete: async (options) => {
          assert.deepEqual(options, { ignoreNotFound: true });
          deleted.push(file.name);
        },
      }));
      const next = start + pageSize < files.length ? { ...query, pageToken: start + pageSize } : null;
      return [page, next];
    },
  };
}

test("feedback uploads no feedback document names are deleted after a day", async () => {
  const db = new FakeFirestore();
  const now = Date.now();
  const old = now - ORPHAN_AFTER_MS - HOUR;
  db.documents.set("feedback/f1", {
    message: "hi",
    attachments: [{ id: "a1", path: "feedback/u1/f1/a1", contentType: "image/png", sizeBytes: 4 }],
    diagnosticLog: { id: "log", path: "feedback/u1/f1/log", contentType: "text/plain", sizeBytes: 3 },
  });
  const bucket = fakeBucket([
    { name: "feedback/u1/f1/a1", created: old }, // referenced attachment
    { name: "feedback/u1/f1/log", created: old }, // referenced diagnostics
    { name: "feedback/u1/f1/a9", created: old }, // extra file under a real feedback id
    { name: "feedback/u2/f2/a1", created: old }, // no feedback document at all
    { name: "feedback/u3/f3/a1", created: now - HOUR }, // too new: its feedback may still be on the way
    { name: "feedback/u4/f4/a1", created: now - ORPHAN_SCAN_MS - HOUR }, // checked by earlier runs
  ]);
  const result = await deleteOrphanFeedbackUploads(db, bucket, now);
  assert.deepEqual(bucket.deleted.sort(), ["feedback/u1/f1/a9", "feedback/u2/f2/a1"]);
  assert.deepEqual(result, { checked: 4, deleted: 2 });
});

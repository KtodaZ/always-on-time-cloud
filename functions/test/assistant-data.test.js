"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { FakeFirestore } = require("../testing/fake-firestore");
const { RawPayload, recordChange } = require("../assistant-data");
const { RecordError } = require("../assistant-records");

const change = (db, build, extra = {}) => recordChange(db, "alice", {
  recordIds: ["p_alarm_volume"], build, assistant: "Claude", tool: "update_settings", summary: "Changed volume", now: Date.now(), ...extra,
});

test("a change rebuilds from fresh data when the record changes underneath it", async () => {
  const db = new FakeFirestore();
  db.documents.set("accounts/alice/values/p_alarm_volume", { payload: "50" });
  const seen = [];
  const result = await change(db, async (current) => {
    seen.push(current.p_alarm_volume);
    // A phone syncs a new value between the read and the commit, once.
    if (seen.length === 1) await db.collection("accounts/alice/values").doc("p_alarm_volume").set({ payload: "60" });
    return { p_alarm_volume: 80 };
  });
  assert.deepEqual(seen, ["50", "60"]);
  assert.deepEqual(result.records, { p_alarm_volume: { before: "60", after: "80" } });
  const activity = db.documents.get(`accounts/alice/assistantActivity/${result.changeId}`);
  assert.equal(activity.writtenAt.getTime(), db.updateTimes.get("accounts/alice/values/p_alarm_volume"));
  assert.equal(db.documents.get("accounts/alice/values/p_alarm_volume").updatedAt.getTime(), activity.writtenAt.getTime());
  assert.equal(Object.keys(db.dump()).filter((path) => path.includes("assistantActivity")).length, 1, "the failed attempt left nothing behind");
});

test("unchanged records write nothing, and invalid payloads never reach Firestore", async () => {
  const db = new FakeFirestore();
  db.documents.set("accounts/alice/values/p_alarm_volume", { payload: "50" });
  assert.equal((await change(db, () => ({ p_alarm_volume: 50 }))).changeId, null);
  await assert.rejects(change(db, () => ({ p_alarm_volume: 500 })), RecordError);
  await assert.rejects(change(db, () => ({ p_alarm_volume: new RawPayload("loud") })), RecordError);
  await assert.rejects(change(db, () => ({ p_max_snoozes: 1 })), /unexpected record/);
  assert.equal(db.writes, 0);
});

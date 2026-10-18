"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { FakeFirestore } = require("../testing/fake-firestore");
const { CHANGE_ID_PATTERN, deleteConnectorData, recordChange } = require("../assistant-data");
const { RecordError } = require("../assistant-records");

/** Changes need an active account, as signed-in phones create it. */
function activeAccount(db) {
  if (!db.documents.has("accounts/alice")) db.documents.set("accounts/alice", { active: true, schemaVersion: 1 });
  return db;
}

const changeIn = (db, build, extra = {}) => recordChange(db, "alice", {
  recordIds: ["p_alarm_volume"], build, assistant: "Claude", tool: "update_settings", summary: "Changed volume", now: Date.now(), ...extra,
});
const change = (db, build, extra) => changeIn(activeAccount(db), build, extra);

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
  assert.match(result.changeId, CHANGE_ID_PATTERN);
});

test("values are written canonically, a re-encoded equal value is no change, and the alert is recorded", async () => {
  const db = new FakeFirestore();
  const id = `s_${"a".repeat(64)}`;
  // A phone wrote the same setting in another order.
  db.documents.set(`accounts/alice/values/${id}`, { payload: '{"enabled":true,"leadTimes":[10,0]}' });
  const same = await change(db, () => ({ [id]: { leadTimes: [0, 10], enabled: true } }), { recordIds: [id] });
  assert.equal(same.changeId, null);
  const off = await change(db, () => ({ [id]: { enabled: false, leadTimes: [10, 0] } }), {
    recordIds: [id], alert: (records) => (records[id] ? "alarms_off" : null),
  });
  assert.equal(db.documents.get(`accounts/alice/values/${id}`).payload, '{"leadTimes":[0,10],"enabled":false}');
  assert.equal(db.documents.get(`accounts/alice/assistantActivity/${off.changeId}`).alert, "alarms_off");
});

test("connector data is only deleted while the account is still disconnected", async () => {
  const db = new FakeFirestore();
  db.documents.set("accounts/alice/assistant/state", { connected: true, connections: 1 });
  db.documents.set("accounts/alice/assistantSnapshots/d1", { payload: "{}" });
  assert.equal(await deleteConnectorData(db, "alice", { onlyIfDisconnected: true }), false);
  assert.ok(db.documents.has("accounts/alice/assistantSnapshots/d1"));
  db.documents.set("accounts/alice/assistant/state", { connected: false, connections: 0 });
  assert.equal(await deleteConnectorData(db, "alice", { onlyIfDisconnected: true }), true);
  assert.equal(db.documents.has("accounts/alice/assistantSnapshots/d1"), false);
});

test("unchanged records write nothing, and invalid payloads never reach Firestore", async () => {
  const db = new FakeFirestore();
  db.documents.set("accounts/alice/values/p_alarm_volume", { payload: "50" });
  assert.equal((await change(db, () => ({ p_alarm_volume: 50 }))).changeId, null);
  await assert.rejects(change(db, () => ({ p_alarm_volume: 500 })), RecordError);
  await assert.rejects(change(db, () => ({ p_alarm_volume: "loud" })), RecordError);
  await assert.rejects(change(db, () => ({ p_max_snoozes: 1 })), /unexpected record/);
  assert.equal(db.writes, 0);
});

test("a change never lands in an account that is being deleted", async () => {
  const db = new FakeFirestore();
  db.documents.set("accounts/alice", { active: false, schemaVersion: 1 });
  await assert.rejects(changeIn(db, () => ({ p_alarm_volume: 80 })), /no longer active/);
  db.documents.delete("accounts/alice");
  await assert.rejects(changeIn(db, () => ({ p_alarm_volume: 80 })), /no longer active/);
  assert.equal(db.writes, 0);

  // Deletion writes its tombstone between the change's reads and its commit: the commit fails,
  // and the rebuilt change sees the tombstone and stops.
  db.documents.set("accounts/alice", { active: true, schemaVersion: 1 });
  let builds = 0;
  await assert.rejects(changeIn(db, async () => {
    builds += 1;
    if (builds === 1) await db.collection("accounts").doc("alice").set({ active: false, schemaVersion: 1 });
    return { p_alarm_volume: 80 };
  }), /no longer active/);
  assert.equal(builds, 1);
  assert.deepEqual(Object.keys(db.dump()), ["accounts/alice"]);
  assert.deepEqual(db.documents.get("accounts/alice"), { active: false, schemaVersion: 1 });
});

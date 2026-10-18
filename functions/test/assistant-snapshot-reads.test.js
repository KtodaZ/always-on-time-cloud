"use strict";

// What the snapshot-backed tools read: only the newest snapshot is parsed, oversized payloads are
// never parsed, and waiting for phones polls publish times rather than payloads.

const assert = require("node:assert/strict");
const test = require("node:test");

const { FakeFirestore } = require("../testing/fake-firestore");
const { MAX_SNAPSHOT_CHARS, readAppliedThrough, readLatestSnapshot } = require("../assistant-data");
const { createRecordingMessaging } = require("../assistant-push");
const { cleanText } = require("../assistant-snapshot");
const { createToolContext, latestSnapshot } = require("../assistant-tool-context");
const { TOOLS } = require("../assistant-tools");

const T0 = Date.parse("2026-10-16T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const tool = (name) => TOOLS.find((item) => item.name === name);
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const payload = (device, appliedThrough, extra = {}) => JSON.stringify({
  device, timeZone: "UTC", valuesAppliedThrough: appliedThrough, paused: { until: 0 }, calendars: [], events: [], ...extra,
});

function setup() {
  const db = new FakeFirestore();
  const clock = { time: T0 };
  db.now = () => clock.time;
  db.documents.set("accounts/alice", { active: true, schemaVersion: 1 });
  const ctx = createToolContext({
    db, uid: "alice", grant: { grantId: "g1", clientName: "Claude", scopes: ["alarms.read"] }, logId: "log_test",
    origin: "https://alwaysontime.zombit.io", now: () => clock.time, messaging: createRecordingMessaging(),
    logger: { info() {}, warn() {}, error() {} },
    sleep: async (ms) => { clock.time += ms; },
  });
  ctx.pushAllowed = async () => true;
  return { db, clock, ctx };
}

/** Counts JSON.parse calls on strings at least `min` characters long while `run` runs. */
async function countParses(min, run) {
  const parse = JSON.parse;
  let count = 0;
  JSON.parse = (text, ...rest) => {
    if (typeof text === "string" && text.length >= min) count += 1;
    return parse(text, ...rest);
  };
  try {
    await run();
  } finally {
    JSON.parse = parse;
  }
  return count;
}

test("only the newest snapshot is read and parsed", async () => {
  const { db, ctx } = setup();
  const filler = "x".repeat(50000);
  db.documents.set(`accounts/alice/assistantSnapshots/${A}`, { schemaVersion: 1, publishedAt: new Date(T0 - HOUR), payload: payload("Old phone", 0, { filler }) });
  db.documents.set(`accounts/alice/assistantSnapshots/${B}`, { schemaVersion: 1, publishedAt: new Date(T0 - 60000), payload: payload("Pixel 9", 0, { filler }) });
  let snapshot;
  const parses = await countParses(50000, async () => { snapshot = await latestSnapshot(ctx); });
  assert.equal(snapshot.device, "Pixel 9");
  assert.equal(parses, 1);
});

test("an oversized payload is rejected before it is parsed", async () => {
  const { db, ctx } = setup();
  // Stored before the rules capped it, or by anything that bypasses them.
  const big = payload("Pixel 9", T0, { filler: "x".repeat(MAX_SNAPSHOT_CHARS) });
  db.documents.set(`accounts/alice/assistantSnapshots/${A}`, { schemaVersion: 1, publishedAt: new Date(T0), payload: big });
  const parses = await countParses(MAX_SNAPSHOT_CHARS, async () => {
    assert.equal((await readLatestSnapshot(db, "alice")).payload, null);
    assert.equal(await latestSnapshot(ctx), null);
    assert.equal(await readAppliedThrough(db, "alice", A), null);
  });
  assert.equal(parses, 0);
  // Under the cap, valuesAppliedThrough is found without parsing the payload.
  db.documents.set(`accounts/alice/assistantSnapshots/${A}`, { schemaVersion: 1, publishedAt: new Date(T0), payload: payload("Pixel 9", T0, { title: '\\"valuesAppliedThrough\\":1' }) });
  assert.equal(await countParses(0, async () => assert.equal(await readAppliedThrough(db, "alice", A), T0)), 0);
  db.documents.set(`accounts/alice/assistantSnapshots/${A}`, { schemaVersion: 1, publishedAt: new Date(T0), payload: '{"device":"Pixel 9"}' });
  assert.equal(await readAppliedThrough(db, "alice", A), 0);
});

test("confirm_change polls publish times and reads a payload only after its phone published again", async () => {
  const { db, clock, ctx } = setup();
  const writtenAt = T0;
  db.documents.set("accounts/alice/assistantActivity/ch_AAAAAAAAAAAAAAAA", { writtenAt: new Date(writtenAt), summary: "x" });
  db.documents.set(`accounts/alice/assistantDevices/${A}`, { platform: "android", deviceName: "Pixel 9", updatedAt: new Date(T0) });
  db.documents.set(`accounts/alice/assistantDevices/${B}`, { platform: "android", deviceName: "Galaxy Tab", updatedAt: new Date(T0) });
  db.documents.set(`accounts/alice/assistantSnapshots/${A}`, { schemaVersion: 1, publishedAt: new Date(T0 - HOUR), payload: payload("Pixel 9", writtenAt - 1) });
  db.documents.set(`accounts/alice/assistantSnapshots/${B}`, { schemaVersion: 1, publishedAt: new Date(T0 - HOUR), payload: payload("Galaxy Tab", writtenAt - 1) });
  // Count full reads of snapshot documents (the polled projection queries don't read single documents).
  const payloadReads = [];
  const Reference = db.collection("accounts").doc("alice").constructor;
  const get = Reference.prototype.get;
  Reference.prototype.get = function () {
    if (this.path.startsWith("accounts/alice/assistantSnapshots/")) payloadReads.push(this.id);
    return get.call(this);
  };
  // Phone A applies the change after a few polls; phone B never does.
  const sleep = ctx.sleep;
  let ticks = 0;
  ctx.sleep = async (ms) => {
    await sleep(ms);
    ticks += 1;
    if (ticks === 3) {
      db.documents.set(`accounts/alice/assistantSnapshots/${A}`, { schemaVersion: 1, publishedAt: new Date(clock.time), payload: payload("Pixel 9", writtenAt) });
    }
  };
  const out = await tool("confirm_change").handler(ctx, { changeId: "ch_AAAAAAAAAAAAAAAA", waitSeconds: 6 });
  assert.equal(out.data.outcome, "partial");
  assert.deepEqual(out.data.appliedOn, ["Pixel 9"]);
  assert.deepEqual(out.data.waitingOn, ["Galaxy Tab"]);
  assert.ok(ticks >= 3);
  // Each phone's payload once at the start, and A's once more after it published.
  Reference.prototype.get = get;
  assert.deepEqual(payloadReads.sort(), [A, A, B].sort());
});

test("refresh waits on publish times and returns the answering phone's snapshot", async () => {
  const { db, ctx } = setup();
  db.documents.set(`accounts/alice/assistantDevices/${A}`, { platform: "android", deviceName: "Pixel 9", fcmToken: "t", updatedAt: new Date(T0) });
  db.documents.set(`accounts/alice/assistantSnapshots/${A}`, { schemaVersion: 1, publishedAt: new Date(T0 - HOUR), payload: payload("Pixel 9", 0) });
  const sleep = ctx.sleep;
  ctx.sleep = async (ms) => {
    await sleep(ms);
    const [message] = ctx.messaging.sent;
    db.documents.set(`accounts/alice/assistantSnapshots/${A}`, { schemaVersion: 1, publishedAt: new Date(ctx.now()), requestId: message.data.requestId, payload: payload("Pixel 9", 0) });
  };
  const out = await tool("refresh").handler(ctx, { waitSeconds: 5 });
  assert.equal(out.data.fresh, true);
  assert.match(out.text, /^Fresh from Pixel 9/);
});

test("alarm history reads a bounded page of the newest entries", async () => {
  const { db, ctx } = setup();
  for (let i = 0; i < 400; i += 1) {
    db.documents.set(`accounts/alice/history/${String(i).padStart(64, "0")}`, {
      createdAt: T0 - i * 60000, payload: JSON.stringify({ title: `Meeting ${i}`, scheduledTime: T0 - i * 60000, firedTime: T0 - i * 60000 }),
    });
  }
  const reads = db.reads;
  const out = await tool("get_alarm_history").handler(ctx, { days: 14 });
  assert.equal(out.data.total, 200, "at most four times what one answer shows");
  assert.equal(out.data.entries.length, 50);
  assert.match(out.data.entries[0].title, /^Meeting 0$/);
  assert.ok(db.reads - reads <= 202, `read ${db.reads - reads} documents`);
});

test("titles lose variation selectors, tag characters and other invisible characters", () => {
  assert.equal(cleanText("Pay️ment\u{E0101} due​⁠ \u{E0041}\u{E007F}nowㅤᅟ͏"), "Payment due now");
  assert.equal(cleanText("Team ❤️ standup"), "Team ❤ standup");
  assert.equal(cleanText("Café 日本"), "Café 日本");
});

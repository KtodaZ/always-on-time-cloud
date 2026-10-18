"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { FakeFirestore } = require("../testing/fake-firestore");
const { SHARDS, combineDays, createUsage, formatWeeklySummary, nest, week, weeklySummary } = require("../assistant-usage");
const { formatTime, parseTime } = require("../assistant-snapshot");

test("the weekly summary is built only from anonymous daily totals", () => {
  const monday = {
    weeklyActive: { claude: 20, chatgpt: 6 },
    connectionsNew: { claude: 3 },
    tools: { get_status: 300, list_upcoming_alarms: 400 },
    errors: { find_events: 7 },
    setupTests: { received: 24, noAnswer: 1 },
    changes: 100,
    undos: 3,
    plusGate: 4,
  };
  const tuesday = {
    weeklyActive: { claude: 11, chatgpt: 5 },
    disconnects: { chatgpt: 1 },
    tools: { set_event_alarms: 580 },
    setupTests: { received: 0 },
    confirms: { confirmed: 9, pending: 1 },
    plusGate: 3,
  };
  assert.equal(formatWeeklySummary([monday, tuesday]),
    "Assistants this week: 42 connected (31 Claude, 11 ChatGPT), 3 new, 1 disconnected, 1,280 tool calls, 1% errors, " +
    "setup test 96% ok, 90% of confirmations applied, 3% of changes undone, 7 Plus-gate replies.");
  assert.equal(formatWeeklySummary([]), "Assistants this week: 0 connected, 0 tool calls, 0 Plus-gate replies.");
});

test("weeks start on Monday (UTC), and the summary reads the seven days before it runs", async () => {
  assert.equal(week(Date.parse("2026-10-18T23:59:00Z")), "2026-10-12");
  assert.equal(week(Date.parse("2026-10-19T00:00:00Z")), "2026-10-19");
  const db = new FakeFirestore();
  db.documents.set("assistantUsage/2026-10-12", { weeklyActive: { claude: 2 }, tools: { get_status: 5 } });
  db.documents.set("assistantUsage/2026-10-18", { weeklyActive: { other: 1 }, tools: { get_status: 5 } });
  db.documents.set("assistantUsage/2026-10-19", { tools: { get_status: 1000 } });
  db.documents.set("assistantUsage/2026-10-11", { tools: { get_status: 1000 } });
  // Days written since sharding keep their totals in shards; the day document still counts.
  db.documents.set("assistantUsage/2026-10-14/shards/3", { tools: { get_status: 7 } });
  db.documents.set("assistantUsage/2026-10-11/shards/0", { tools: { get_status: 1000 } });
  assert.match(await weeklySummary(db, Date.parse("2026-10-19T09:00:00Z")), /^Assistants this week: 3 connected \(2 Claude, 1 other\), 17 tool calls/);
  db.documents.delete("assistantUsage/2026-10-14/shards/3");
  assert.match(await weeklySummary(db, Date.parse("2026-10-19T09:00:00Z")), /^Assistants this week: 3 connected \(2 Claude, 1 other\), 10 tool calls/);
});

test("usage writes nested increments in one merge to a shard of the day, and never throws", async () => {
  assert.throws(() => nest({ "tools.bad/name": 1 }, (n) => n), /invalid usage counter/);
  const db = new FakeFirestore();
  let shard = 0;
  const usage = createUsage({ db, increment: (n) => ({ __increment: n }), now: () => Date.parse("2026-10-16T01:00:00Z"), random: () => (shard++ % SHARDS) / SHARDS });
  await usage({ "tools.get_status": 1, "errors.get_status": 1 });
  await usage({ "tools.get_status": 1, plusGate: 1 });
  assert.deepEqual(db.documents.get("assistantUsage/2026-10-16/shards/0"), { tools: { get_status: 1 }, errors: { get_status: 1 } });
  assert.deepEqual(db.documents.get("assistantUsage/2026-10-16/shards/1"), { tools: { get_status: 1 }, plusGate: 1 });
  assert.equal(db.writes, 2, "one write per call");
  const broken = createUsage({ db: { collection: () => { throw new Error("down"); } }, increment: (n) => n });
  await broken({ plusGate: 1 });
});

test("deferred counts cost no write and go out with the next one", async () => {
  const db = new FakeFirestore();
  const usage = createUsage({ db, increment: (n) => ({ __increment: n }), now: () => Date.parse("2026-10-16T01:00:00Z") });
  usage.defer({ rateLimited: 1 });
  usage.defer({ rateLimited: 1, "tools.get_status": 1 });
  assert.equal(db.writes, 0);
  assert.throws(() => usage.defer({ "bad/name": 1 }), /invalid usage counter/);
  await usage({ "tools.get_status": 1 });
  assert.equal(db.writes, 1);
  const shards = [...db.documents].filter(([path]) => path.startsWith("assistantUsage/2026-10-16/shards/")).map(([, data]) => data);
  assert.deepEqual(combineDays(shards), { rateLimited: 2, tools: { get_status: 2 } });
  await usage({});
  assert.equal(db.writes, 1, "nothing left to write");
});

test("assistant times without an offset are read in the phone's time zone, across DST", () => {
  const zone = "America/Los_Angeles";
  assert.equal(parseTime("2026-10-20T09:00", zone), Date.parse("2026-10-20T16:00:00Z"));
  assert.equal(parseTime("2026-11-02", zone), Date.parse("2026-11-02T08:00:00Z"), "after DST ends");
  assert.equal(parseTime("2026-11-01T01:30", zone) % 1000, 0);
  assert.equal(parseTime("2026-10-20T09:00:00+02:00", zone), Date.parse("2026-10-20T07:00:00Z"));
  assert.throws(() => parseTime("tomorrow", zone), /ISO 8601/);
  assert.equal(formatTime(Date.parse("2026-10-20T16:00:00Z"), zone), "Tue, Oct 20, 9:00 AM");
});

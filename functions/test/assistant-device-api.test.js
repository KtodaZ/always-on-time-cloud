"use strict";

// assistantDeviceApi: per-device key authentication, the ping, snapshot and sync endpoints, and limits.

const assert = require("node:assert/strict");
const { createHash, randomBytes } = require("node:crypto");
const test = require("node:test");

const { FakeFirestore } = require("../testing/fake-firestore");
const { PAGE_SIZE, createDeviceApi } = require("../assistant-device-api");
const { createInstanceLimiters } = require("../assistant-limits");

const T0 = Date.parse("2026-10-22T12:00:00Z");
const DEVICE = "22222222-2222-4222-8222-222222222222";
const OTHER_DEVICE = "33333333-3333-4333-8333-333333333333";
const KEY = randomBytes(32).toString("base64url");
const BOB_KEY = randomBytes(32).toString("base64url");
const hash = (key) => createHash("sha256").update(key, "utf8").digest("hex");
const P = (name) => `p_${name}`;
const E = (n) => `e_${String(n).padStart(64, "0")}`;

function setup() {
  const db = new FakeFirestore();
  const clock = { time: T0 };
  db.now = () => clock.time;
  const logs = [];
  const logger = Object.fromEntries(["info", "warn", "error"].map((level) => [level, (message, fields) => logs.push({ level, message, ...fields })]));
  const device = {
    platform: "ios", deviceName: "iPhone 17", appVersion: "1.4.0", apnsToken: "ab".repeat(32), apnsEnvironment: "production",
    deviceKeyHash: hash(KEY), capabilities: ["pause"], updatedAt: new Date(T0 - 60000),
  };
  for (const uid of ["alice", "bob"]) {
    db.documents.set(`accounts/${uid}`, { active: true, schemaVersion: 1 });
    db.documents.set(`accounts/${uid}/assistant/state`, { connected: true, connections: 1, updatedAt: new Date(T0) });
    db.documents.set(`accounts/${uid}/assistant/log`, { logId: `log_${uid}` });
  }
  db.documents.set(`accounts/alice/assistantDevices/${DEVICE}`, device);
  db.documents.set(`accounts/bob/assistantDevices/${OTHER_DEVICE}`, { ...device, deviceKeyHash: hash(BOB_KEY) });
  const limiters = createInstanceLimiters();
  const handler = createDeviceApi({ db, logger, now: () => clock.time, limiters });
  async function call(method, path, body, { key = KEY, raw, headers = {} } = {}) {
    const rawBody = raw ?? Buffer.from(JSON.stringify(body ?? {}), "utf8");
    const req = {
      method,
      url: path,
      headers: { "x-forwarded-for": "203.0.113.7", ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
      rawBody,
    };
    const res = {
      statusCode: 200,
      headers: {},
      text: "",
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      end(text) { this.text = text ?? ""; },
    };
    await handler(req, res);
    return { status: res.statusCode, headers: res.headers, body: res.text ? JSON.parse(res.text) : null };
  }
  return { db, clock, logs, call, device: () => db.documents.get(`accounts/alice/assistantDevices/${DEVICE}`) };
}

const ping = (extra = {}) => ({ uid: "alice", deviceId: DEVICE, pingId: "ping_abc", ...extra });

test("only the device's own key opens it, while the account is active and an assistant is connected", async () => {
  const env = setup();
  const denied = [
    ["no key", ping(), { key: null }],
    ["malformed key", ping(), { key: "short" }],
    ["wrong key", ping(), { key: randomBytes(32).toString("base64url") }],
    ["another account's key", ping(), { key: BOB_KEY }],
    ["another account's device", ping({ deviceId: OTHER_DEVICE })],
    ["the key on another account", ping({ uid: "bob", deviceId: OTHER_DEVICE })],
    ["unknown device", ping({ deviceId: "44444444-4444-4444-8444-444444444444" })],
    ["bad uid", ping({ uid: "accounts/alice" })],
    ["bad device id", ping({ deviceId: "not-a-uuid" })],
    ["uid missing", (({ uid, ...rest }) => rest)(ping())],
    ["device id not a string", ping({ deviceId: 7 })],
  ];
  for (const [label, body, options] of denied) {
    const response = await env.call("POST", "/v1/ping", body, options);
    assert.deepEqual([response.status, response.body], [401, { error: "unauthorized" }], label);
  }
  // The device document without a key hash (an app that predates the device API).
  const device = env.device();
  env.db.documents.set(`accounts/alice/assistantDevices/${DEVICE}`, { ...device, deviceKeyHash: undefined });
  assert.equal((await env.call("POST", "/v1/ping", ping())).status, 401, "no deviceKeyHash");
  env.db.documents.set(`accounts/alice/assistantDevices/${DEVICE}`, device);
  // Disconnected, or the account deleted (tombstoned).
  env.db.documents.set("accounts/alice/assistant/state", { connected: false, connections: 0, updatedAt: new Date(T0) });
  assert.equal((await env.call("POST", "/v1/ping", ping())).status, 401, "disconnected");
  env.db.documents.delete("accounts/alice/assistant/state");
  assert.equal((await env.call("POST", "/v1/ping", ping())).status, 401, "never connected");
  env.db.documents.set("accounts/alice/assistant/state", { connected: true, connections: 1, updatedAt: new Date(T0) });
  env.db.documents.set("accounts/alice", { active: false, schemaVersion: 1 });
  assert.equal((await env.call("POST", "/v1/ping", ping())).status, 401, "inactive account");
  assert.equal(env.device().lastPing, undefined, "nothing was written");
  env.db.documents.set("accounts/alice", { active: true, schemaVersion: 1 });
  assert.equal((await env.call("POST", "/v1/ping", ping())).status, 204);
  // Log lines name the account by its logId only.
  assert.ok(env.logs.length > 0);
  assert.ok(env.logs.every((line) => !Object.values(line).includes("alice") && !JSON.stringify(line).includes(KEY) && !JSON.stringify(line).includes(hash(KEY))));
  assert.equal(env.logs.at(-1).logId, "log_alice");
});

test("repeated failed keys from one caller are answered 429 once the failure budget is used", async () => {
  const env = setup();
  const statuses = [];
  for (let i = 0; i < 32; i += 1) statuses.push((await env.call("POST", "/v1/ping", ping(), { key: BOB_KEY })).status);
  assert.deepEqual(statuses.slice(0, 30), Array(30).fill(401));
  assert.deepEqual(statuses.slice(30), [429, 429]);
  // A working key from the same network is still verified and served.
  assert.equal((await env.call("POST", "/v1/ping", ping())).status, 204);
});

test("routes: unknown paths 404, wrong methods 405 with Allow, the function name prefix is accepted", async () => {
  const env = setup();
  assert.equal((await env.call("POST", "/v1/other", ping())).status, 404);
  assert.equal((await env.call("POST", "/v2/ping", ping())).status, 404);
  const wrong = await env.call("GET", "/v1/sync", {});
  assert.deepEqual([wrong.status, wrong.headers.allow], [405, "POST"]);
  assert.equal((await env.call("POST", "/v1/snapshot", {})).headers.allow, "PUT");
  assert.equal((await env.call("POST", "/assistantDeviceApi/v1/ping", ping())).status, 204);
  assert.equal((await env.call("POST", "/v1/ping?x=1", ping())).status, 204);
  const response = await env.call("POST", "/v1/ping", ping());
  assert.equal(response.headers["cache-control"], "no-store");
});

test("ping records lastPing and updatedAt with the server time and keeps the rest of the device", async () => {
  const env = setup();
  env.clock.time = T0 + 5000;
  const before = env.device();
  const response = await env.call("POST", "/v1/ping", ping({ pingId: "p".repeat(64) }));
  assert.deepEqual([response.status, response.body], [204, null]);
  const after = env.device();
  assert.equal(after.lastPing.id, "p".repeat(64));
  assert.ok(after.lastPing.receivedAt instanceof Date && after.lastPing.receivedAt.getTime() >= T0 + 5000);
  assert.equal(after.updatedAt.getTime(), after.lastPing.receivedAt.getTime());
  assert.deepEqual({ ...after, lastPing: undefined, updatedAt: undefined }, { ...before, lastPing: undefined, updatedAt: undefined });
  for (const bad of [ping({ pingId: "p".repeat(65) }), ping({ pingId: "" }), ping({ pingId: 5 }), ping({ extra: true }), (({ pingId, ...rest }) => rest)(ping())]) {
    assert.equal((await env.call("POST", "/v1/ping", bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal((await env.call("POST", "/v1/ping", null, { raw: Buffer.from("{nope") })).status, 400);
});

test("snapshot replaces this device's snapshot like a phone write, within the same limits", async () => {
  const env = setup();
  const path = `accounts/alice/assistantSnapshots/${DEVICE}`;
  env.db.documents.set(path, { schemaVersion: 1, publishedAt: new Date(T0 - 60000), requestId: "req_old", payload: "{}" });
  const body = (extra = {}) => ({ uid: "alice", deviceId: DEVICE, payload: '{"events":[]}', ...extra });
  assert.equal((await env.call("PUT", "/v1/snapshot", body({ requestId: "req_new" }))).status, 204);
  const stored = env.db.documents.get(path);
  assert.deepEqual(Object.keys(stored).sort(), ["payload", "publishedAt", "requestId", "schemaVersion"]);
  assert.deepEqual([stored.schemaVersion, stored.requestId, stored.payload], [1, "req_new", '{"events":[]}']);
  assert.ok(stored.publishedAt.getTime() >= T0);
  // Without a requestId (or null), the old one does not survive.
  assert.equal((await env.call("PUT", "/v1/snapshot", body())).status, 204);
  assert.equal(env.db.documents.get(path).requestId, undefined);
  assert.equal((await env.call("PUT", "/v1/snapshot", body({ requestId: null }))).status, 204);
  assert.equal(Object.hasOwn(env.db.documents.get(path), "requestId"), false);
  // The largest payload the rules accept, JSON-escaped in the body, still fits.
  const largest = `"${'\\"'.repeat(399_999)}"`;
  assert.equal(largest.length, 800_000);
  assert.equal((await env.call("PUT", "/v1/snapshot", body({ payload: largest }))).status, 204);
  assert.equal(env.db.documents.get(path).payload.length, 800_000);
  for (const bad of [body({ payload: "x".repeat(800_001) }), body({ payload: {} }), body({ requestId: "r".repeat(65) }), body({ requestId: 5 }),
    body({ schemaVersion: 2 }), (({ payload, ...rest }) => rest)(body())]) {
    assert.equal((await env.call("PUT", "/v1/snapshot", bad)).status, 400);
  }
  const huge = await env.call("PUT", "/v1/snapshot", null, { raw: Buffer.alloc(2 * 1024 * 1024 + 1, 0x20) });
  assert.equal(huge.status, 413);
  // Another device's snapshot is out of reach: the path comes from the authenticated deviceId.
  assert.equal((await env.call("PUT", "/v1/snapshot", { ...body(), deviceId: OTHER_DEVICE })).status, 401);
});

test("a write refused after a disconnect raced the check is answered 401", async () => {
  const env = setup();
  // The first read (the pre-check) sees the account connected; the transaction's read does not.
  const original = env.db.runTransaction.bind(env.db);
  env.db.runTransaction = async (callback) => {
    if (env.raced) return original(callback);
    env.raced = true;
    env.db.documents.set("accounts/alice/assistant/state", { connected: false, connections: 0, updatedAt: new Date(T0) });
    return original(callback);
  };
  // consume() runs the first transaction; it flips the state before the write's transaction.
  const response = await env.call("PUT", "/v1/snapshot", { uid: "alice", deviceId: DEVICE, payload: "{}" });
  assert.equal(response.status, 401);
  assert.equal(env.db.documents.has(`accounts/alice/assistantSnapshots/${DEVICE}`), false);
});

function addValue(env, id, payload, updatedAt) {
  env.db.documents.set(`accounts/alice/values/${id}`, updatedAt === undefined ? { payload } : { payload, updatedAt: new Date(updatedAt) });
}

test("sync returns the connector's values after `since`, oldest first, and the change without its summary", async () => {
  const env = setup();
  addValue(env, P("alarms_paused_until"), "-1", T0 + 30);
  addValue(env, P("alarm_volume"), "40", T0 + 10);
  addValue(env, E(1), '{"leadTimes":[15]}', T0 + 20);
  addValue(env, E(2), '{"enabled":false}', T0);
  // Phone writes carry no updatedAt and never come back.
  addValue(env, P("theme_preference"), '"dark"');
  env.db.documents.set("accounts/alice/assistantActivity/ch_abcdefghijklmnop", {
    assistant: "Claude", tool: "pause_alarms", summary: "Paused alarms before Dentist", alert: "paused",
    records: { [P("alarms_paused_until")]: { before: null, after: "-1" } }, writtenAt: new Date(T0 + 30), expiresAt: new Date(T0 + 86400000),
  });
  const response = await env.call("POST", "/v1/sync", { uid: "alice", deviceId: DEVICE, since: T0, changeId: "ch_abcdefghijklmnop" });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    change: { changeId: "ch_abcdefghijklmnop", assistant: "Claude", alert: "paused", writtenAt: T0 + 30, undoneAt: null, recordIds: [P("alarms_paused_until")] },
    values: [
      { id: P("alarm_volume"), payload: "40", updatedAt: T0 + 10 },
      { id: E(1), payload: '{"leadTimes":[15]}', updatedAt: T0 + 20 },
      { id: P("alarms_paused_until"), payload: "-1", updatedAt: T0 + 30 },
    ],
    more: false,
  });
  assert.doesNotMatch(JSON.stringify(response.body), /Dentist|summary|before/);
  const all = await env.call("POST", "/v1/sync", { uid: "alice", deviceId: DEVICE, since: 0 });
  assert.deepEqual(all.body.values.map((value) => value.id), [E(2), P("alarm_volume"), E(1), P("alarms_paused_until")]);
  assert.equal(all.body.change, null);
  const undone = env.db.documents.get("accounts/alice/assistantActivity/ch_abcdefghijklmnop");
  env.db.documents.set("accounts/alice/assistantActivity/ch_abcdefghijklmnop", { ...undone, undoneAt: new Date(T0 + 99), alert: undefined });
  const later = await env.call("POST", "/v1/sync", { uid: "alice", deviceId: DEVICE, since: T0 + 30, changeId: "ch_abcdefghijklmnop" });
  assert.deepEqual([later.body.change.undoneAt, later.body.change.alert, later.body.values], [T0 + 99, null, []]);
  const unknown = await env.call("POST", "/v1/sync", { uid: "alice", deviceId: DEVICE, since: 0, changeId: "ch_zzzzzzzzzzzzzzzz" });
  assert.equal(unknown.body.change, null);
  for (const bad of [{ since: -1 }, { since: 1.5 }, { since: "0" }, { since: 253_402_300_799_999 }, { since: 0, changeId: "nope" }, { since: 0, extra: 1 }, {}]) {
    assert.equal((await env.call("POST", "/v1/sync", { uid: "alice", deviceId: DEVICE, ...bad })).status, 400, JSON.stringify(bad));
  }
});

test("sync pages hold at most 50 values and end on a millisecond boundary", async () => {
  const env = setup();
  // 49 values at distinct times, then three written in one commit, then one more.
  for (let i = 0; i < 49; i += 1) addValue(env, E(i), "null", T0 + i);
  for (let i = 49; i < 52; i += 1) addValue(env, E(i), "null", T0 + 49);
  addValue(env, E(52), "null", T0 + 50);
  const sync = (since) => env.call("POST", "/v1/sync", { uid: "alice", deviceId: DEVICE, since }).then((response) => response.body);
  const first = await sync(0);
  assert.equal(PAGE_SIZE, 50);
  assert.deepEqual([first.values.length, first.more], [49, true], "the millisecond split by the page limit moves to the next page");
  const second = await sync(first.values.at(-1).updatedAt);
  assert.deepEqual(second.values.map((value) => value.id).sort(), [E(49), E(50), E(51), E(52)]);
  assert.equal(second.more, false);
  // One commit that wrote more than a page comes back whole.
  const env2 = setup();
  for (let i = 0; i < 70; i += 1) addValue(env2, E(i), "null", T0 + 5);
  addValue(env2, E(70), "null", T0 + 6);
  const bucket = (await env2.call("POST", "/v1/sync", { uid: "alice", deviceId: DEVICE, since: 0 })).body;
  assert.deepEqual([bucket.values.length, bucket.more], [70, true]);
  const rest = (await env2.call("POST", "/v1/sync", { uid: "alice", deviceId: DEVICE, since: T0 + 5 })).body;
  assert.deepEqual([rest.values.map((value) => value.id), rest.more], [[E(70)], false]);
});

test("each device gets 200 calls per 10 minutes", async () => {
  const env = setup();
  const body = { uid: "alice", deviceId: DEVICE, since: T0 };
  for (let i = 0; i < 200; i += 1) assert.equal((await env.call("POST", "/v1/sync", body)).status, 200);
  const limited = await env.call("POST", "/v1/sync", body);
  assert.deepEqual([limited.status, limited.headers["retry-after"]], [429, "600"]);
  env.clock.time += 10 * 60 * 1000;
  assert.equal((await env.call("POST", "/v1/sync", body)).status, 200);
});

test("an unexpected failure is a plain 500 and its log line names no account", async () => {
  const env = setup();
  const original = env.db.collection.bind(env.db);
  env.db.collection = (name) => {
    const collection = original(name);
    if (name !== "accounts") return collection;
    const doc = collection.doc.bind(collection);
    collection.doc = (id) => {
      const ref = doc(id);
      const sub = ref.collection.bind(ref);
      ref.collection = (child) => {
        const inner = sub(child);
        if (child === "values") inner.where = () => { throw new Error("boom at accounts/alice/values"); };
        return inner;
      };
      return ref;
    };
    return collection;
  };
  const response = await env.call("POST", "/v1/sync", { uid: "alice", deviceId: DEVICE, since: 0 });
  assert.deepEqual([response.status, response.body], [500, { error: "server error" }]);
  const line = env.logs.at(-1);
  assert.equal(line.outcome, "unexpected_error");
  assert.doesNotMatch(JSON.stringify(line), /accounts\/alice/);
});

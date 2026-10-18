"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { COLLECTIONS, FirestorePushStore, sha256Hex, subscriptionDocumentId } = require("../ios-push-firestore");
const { NEW_INSTALL_RATE, clientNetworkKey, createIosPushService, parseApiRoute } = require("../ios-push-service");
const { FakeFirestore } = require("../testing/fake-firestore");

const MINUTE = 60 * 1000;
// 09:00 in Los Angeles.
const START = Date.parse("2026-10-07T16:00:00.000Z");
const APP_CHECK = "valid-app-check-token";
const INSTALL_ID = "AbCdEfGhIjKlMnOpQrStUv";
const SECRET = "s".repeat(43);
const APNS_TOKEN = "ab".repeat(32);
const HEARTBEAT = { intervalMinutes: 20, activeHours: { start: "07:00", end: "22:00" }, timeZone: "America/Los_Angeles" };
const CHANNEL_ID = "6f0d5a3e-channel";
const CHANNEL_TOKEN = "google-channel-token-with-plenty-of-entropy";
const RESOURCE_ID = "resource-123";
const GRAPH_ID = "7c6b-graph-subscription";
const CLIENT_STATE = "graph-client-state-with-plenty-of-entropy";

function harness({ enforceAppCheck = true, apns = () => ({ status: 200 }) } = {}) {
  const db = new FakeFirestore();
  const store = new FirestorePushStore(db);
  const pushes = [];
  let clock = START;
  let claimCounter = 0;
  let dispatchCounter = 0;
  const service = createIosPushService({
    store,
    verifyAppCheck: async (token) => {
      if (token !== APP_CHECK) throw new Error("invalid");
      return true;
    },
    enforceAppCheck: () => enforceAppCheck,
    sendPush: async (request) => {
      pushes.push(structuredClone(request));
      return apns(request, pushes.length);
    },
    now: () => clock,
    newClaimId: () => `claim-${++claimCounter}`,
    newDispatchId: () => (++dispatchCounter).toString(16).padStart(32, "0"),
  });
  const dispatchPrefix = `${COLLECTIONS.dispatches}/`;
  const dispatches = () => [...db.documents].filter(([path]) => path.startsWith(dispatchPrefix))
    .map(([path, value]) => ({ id: path.slice(dispatchPrefix.length), ...structuredClone(value) }));

  async function call(handler, { method = "GET", path = "/", headers = {}, body } = {}) {
    const req = {
      method,
      originalUrl: path,
      headers: { "x-forwarded-for": "198.51.100.7", ...headers },
      rawBody: body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
    };
    const res = {
      statusCode: 0,
      headers: {},
      body: "",
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      end(value = "") { this.body = String(value); },
    };
    await service[handler](req, res);
    return { status: res.statusCode, headers: res.headers, json: res.body ? safeJson(res.body) : null, text: res.body };
  }

  const api = (method, path, { body, auth = SECRET, appCheck = APP_CHECK, headers = {} } = {}) => call("apiHandler", {
    method,
    path,
    body,
    headers: {
      ...(appCheck ? { "x-firebase-appcheck": appCheck } : {}),
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...headers,
    },
  });

  return {
    db,
    store,
    pushes,
    service,
    api,
    call,
    get now() { return clock; },
    advance(ms) { clock += ms; },
    setNow(value) { clock = value; },
    install: (id = INSTALL_ID) => db.documents.get(`${COLLECTIONS.installs}/${id}`),
    subscription: (provider, id) => db.documents.get(`${COLLECTIONS.subscriptions}/${subscriptionDocumentId(provider, id)}`),
    register: (overrides = {}) => api("POST", "/v1/installations", {
      auth: null,
      body: { installId: INSTALL_ID, installSecret: SECRET, apnsToken: APNS_TOKEN, environment: "development", heartbeat: HEARTBEAT, ...overrides },
    }),
    google: (headers) => call("googleWebhookHandler", {
      method: "POST",
      path: "/",
      headers: {
        "x-goog-channel-id": CHANNEL_ID,
        "x-goog-channel-token": CHANNEL_TOKEN,
        "x-goog-resource-id": RESOURCE_ID,
        "x-goog-resource-state": "exists",
        "x-goog-message-number": "2",
        ...headers,
      },
    }),
    graph: (value) => call("microsoftWebhookHandler", { method: "POST", path: "/", body: { value } }),
    dispatches,
    /** Runs the Firestore trigger for every queued dispatch, as Eventarc would. */
    async deliverDispatches() {
      const outcomes = [];
      for (const { id, ...data } of dispatches()) outcomes.push(await service.deliverDispatch(id, data));
      return outcomes;
    },
  };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch (_error) { return text; }
}

async function withGoogleSubscription(h, expiresAtMs = h.now + 7 * 24 * 60 * MINUTE) {
  if (!h.install()) assert.equal((await h.register()).status, 201);
  const response = await h.api("PUT", `/v1/installations/${INSTALL_ID}/subscriptions/google/${CHANNEL_ID}`, {
    body: { resourceId: RESOURCE_ID, expiresAtMs, channelTokenHash: sha256Hex(CHANNEL_TOKEN) },
  });
  assert.equal(response.status, 204);
}

async function withGraphSubscription(h, expiresAtMs = h.now + 3 * 24 * 60 * MINUTE) {
  if (!h.install()) assert.equal((await h.register()).status, 201);
  const response = await h.api("PUT", `/v1/installations/${INSTALL_ID}/subscriptions/microsoft/${GRAPH_ID}`, {
    body: { expiresAtMs, clientStateHash: sha256Hex(CLIENT_STATE) },
  });
  assert.equal(response.status, 204);
}

// --- Routing -------------------------------------------------------------------------------

test("API routes accept only the documented paths and methods", async () => {
  assert.deepEqual(parseApiRoute("/v1/installations"), { kind: "collection" });
  assert.deepEqual(parseApiRoute("/iosPushApi/v1/installations"), { kind: "collection" });
  assert.deepEqual(parseApiRoute(`/v1/installations/${INSTALL_ID}/alarms`), { kind: "alarms", installId: INSTALL_ID });
  assert.deepEqual(parseApiRoute(`/v1/installations/${INSTALL_ID}/subscriptions/microsoft/a%3Db`),
    { kind: "subscription", installId: INSTALL_ID, provider: "microsoft", subscriptionId: "a=b" });
  assert.equal(parseApiRoute(`/v1/installations/${INSTALL_ID}/subscriptions/icloud/x`), null);
  assert.equal(parseApiRoute(`/v1/installations/${INSTALL_ID}/subscriptions/google/a%2Fb`), null);
  assert.equal(parseApiRoute("/v1/installations/short"), null);
  assert.equal(parseApiRoute("/v2/installations"), null);

  const h = harness();
  assert.equal((await h.api("GET", "/v1/installations")).status, 405);
  assert.equal((await h.api("POST", `/v1/installations/${INSTALL_ID}/alarms`)).status, 405);
  assert.equal((await h.api("PUT", "/nope")).status, 404);
});

test("rate-limit keys use the proxy-appended client address and group IPv6 by /64", () => {
  assert.equal(clientNetworkKey({ headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.7" } }), "v4:198.51.100.7");
  assert.equal(clientNetworkKey({ headers: { "x-forwarded-for": "2001:db8:1:2:aaaa::1" } }), "v6:2001:0db8:0001:0002");
  assert.equal(clientNetworkKey({ headers: { "x-forwarded-for": "2001:db8:1:2:bbbb::9" } }), "v6:2001:0db8:0001:0002");
  assert.equal(clientNetworkKey({ headers: {}, ip: "::ffff:192.0.2.1" }), "v4:192.0.2.1");
});

// --- Registration --------------------------------------------------------------------------

test("registration requires App Check, stores only the secret hash, and is idempotent", async () => {
  const h = harness();
  assert.equal((await h.api("POST", "/v1/installations", { auth: null, appCheck: null, body: {} })).status, 401);
  assert.equal((await h.api("POST", "/v1/installations", { auth: null, appCheck: "forged", body: {} })).status, 401);

  const created = await h.register();
  assert.equal(created.status, 201);
  assert.deepEqual(created.json, { installId: INSTALL_ID });
  assert.equal(created.headers["cache-control"], "no-store");

  const stored = h.install();
  assert.equal(stored.installSecretHash, sha256Hex(SECRET));
  assert.equal(JSON.stringify(stored).includes(SECRET), false);
  assert.equal(stored.apnsToken, APNS_TOKEN);
  assert.equal(stored.apnsEnvironment, "development");
  assert.deepEqual(stored.heartbeat, HEARTBEAT);
  assert.equal(stored.nextWakeAtMs, START + 20 * MINUTE);

  const retried = await h.register({ apnsToken: "cd".repeat(32) });
  assert.equal(retried.status, 200);
  assert.equal(h.install().apnsToken, "cd".repeat(32));
  assert.equal((await h.register({ installSecret: "t".repeat(43) })).status, 409);
});

test("registration validates every field and rejects unknown ones", async () => {
  const h = harness();
  const cases = [
    { installId: "short" },
    { installSecret: "too-short" },
    { apnsToken: "AB".repeat(32) },
    { environment: "staging" },
    { heartbeat: { ...HEARTBEAT, intervalMinutes: 14 } },
    { heartbeat: { ...HEARTBEAT, intervalMinutes: 31 } },
    { heartbeat: { ...HEARTBEAT, activeHours: { start: "07:00", end: "07:00" } } },
    { heartbeat: { ...HEARTBEAT, activeHours: { start: "7:00", end: "22:00" } } },
    { heartbeat: { ...HEARTBEAT, timeZone: "Mars/Olympus" } },
    { heartbeat: { ...HEARTBEAT, extra: true } },
    { calendarTitle: "Board meeting" },
  ];
  for (const overrides of cases) {
    const response = await h.register(overrides);
    assert.equal(response.status, 400, JSON.stringify(overrides));
  }
  assert.equal(h.install(), undefined);
  const oversized = await h.api("POST", "/v1/installations", { auth: null, body: "x".repeat(40 * 1024) });
  assert.equal(oversized.status, 413);
});

test("registration is rate limited per client network", async () => {
  const h = harness();
  for (let index = 0; index < 20; index += 1) {
    const response = await h.api("POST", "/v1/installations", { auth: null, body: { installId: "bad" } });
    assert.equal(response.status, 400);
  }
  assert.equal((await h.register()).status, 429);
  const otherNetwork = await h.api("POST", "/v1/installations", {
    auth: null,
    headers: { "x-forwarded-for": "192.0.2.50" },
    body: { installId: INSTALL_ID, installSecret: SECRET, apnsToken: APNS_TOKEN, environment: "production", heartbeat: HEARTBEAT },
  });
  assert.equal(otherNetwork.status, 201);
  h.advance(60 * MINUTE);
  assert.equal((await h.register()).status, 200);
  assert.equal(Object.keys(h.db.dump()).filter((path) => path.startsWith(COLLECTIONS.rateLimits)).every(
    (path) => !path.includes("198.51.100.7"),
  ), true);
});

test("App Check enforcement can be relaxed for registration but invalid tokens still fail", async () => {
  const h = harness({ enforceAppCheck: false });
  assert.equal((await h.api("POST", "/v1/installations", { auth: null, appCheck: "forged", body: {} })).status, 401);
  const response = await h.api("POST", "/v1/installations", {
    auth: null,
    appCheck: null,
    body: { installId: INSTALL_ID, installSecret: SECRET, apnsToken: APNS_TOKEN, environment: "development", heartbeat: HEARTBEAT },
  });
  assert.equal(response.status, 201);
});

// --- Authenticated install calls -----------------------------------------------------------

test("install calls authenticate with the bearer secret; App Check is optional for the NSE", async () => {
  const h = harness();
  await h.register();
  const path = `/v1/installations/${INSTALL_ID}/alarms`;
  const body = { alarms: [] };
  assert.equal((await h.api("PUT", path, { body, auth: null })).status, 401);
  assert.equal((await h.api("PUT", path, { body, auth: "x".repeat(43) })).status, 401);
  assert.equal((await h.api("PUT", path, { body, appCheck: "forged" })).status, 401);
  assert.equal((await h.api("PUT", path, { body, appCheck: null })).status, 204);
  assert.equal((await h.api("PUT", `/v1/installations/${"Z".repeat(22)}/alarms`, { body })).status, 401);
});

test("install calls are rate limited per install", async () => {
  const h = harness();
  await h.register();
  const path = `/v1/installations/${INSTALL_ID}/alarms`;
  for (let index = 0; index < 60; index += 1) {
    assert.equal((await h.api("PUT", path, { body: { alarms: [] } })).status, 204);
  }
  assert.equal((await h.api("PUT", path, { body: { alarms: [] } })).status, 429);
  h.advance(MINUTE);
  assert.equal((await h.api("PUT", path, { body: { alarms: [] } })).status, 204);
});

test("updating an install changes its token and preferences and re-enables it", async () => {
  const h = harness({ apns: () => ({ status: 410, reason: "Unregistered" }) });
  await h.register();
  h.advance(20 * MINUTE);
  await h.service.scheduledPushes();
  assert.equal(h.install().enabled, false);
  assert.equal(h.install().nextWakeAtMs, null);

  const update = await h.api("PUT", `/v1/installations/${INSTALL_ID}`, {
    body: { apnsToken: "ef".repeat(32), environment: "production", heartbeat: { ...HEARTBEAT, intervalMinutes: 30 } },
  });
  assert.equal(update.status, 204);
  const install = h.install();
  assert.equal(install.enabled, true);
  assert.equal(install.apnsToken, "ef".repeat(32));
  assert.equal(install.apnsEnvironment, "production");
  assert.equal(install.heartbeat.intervalMinutes, 30);
  assert.equal(typeof install.nextWakeAtMs, "number");
});

test("deleting an install removes it and its subscription mappings", async () => {
  const h = harness();
  await withGoogleSubscription(h);
  await withGraphSubscription(h);
  assert.equal((await h.api("DELETE", `/v1/installations/${INSTALL_ID}`)).status, 204);
  const remaining = Object.keys(h.db.dump()).filter((path) => !path.startsWith(COLLECTIONS.rateLimits));
  assert.deepEqual(remaining, []);
  assert.equal((await h.api("DELETE", `/v1/installations/${INSTALL_ID}`)).status, 401);
});

// --- Alarms --------------------------------------------------------------------------------

test("alarm snapshots store only hashed IDs and trigger times, dropping past entries", async () => {
  const h = harness();
  await h.register();
  const path = `/v1/installations/${INSTALL_ID}/alarms`;
  const response = await h.api("PUT", path, {
    body: {
      alarms: [
        { id: "event-abc|2026-10-07T17:00Z|10", triggerAtMs: START + 60 * MINUTE },
        { id: "event-def|past", triggerAtMs: START - 1 },
        { id: "far-future", triggerAtMs: START + 91 * 24 * 60 * MINUTE },
      ],
    },
  });
  assert.equal(response.status, 204);
  const install = h.install();
  assert.deepEqual(install.alarms, [{ key: sha256Hex("event-abc|2026-10-07T17:00Z|10"), triggerAtMs: START + 60 * MINUTE, sent: {} }]);
  assert.equal(JSON.stringify(h.db.dump()).includes("event-abc"), false);
  assert.equal(install.nextWakeAtMs, START + 20 * MINUTE);

  assert.equal((await h.api("PUT", path, { body: { alarms: [{ id: "a", triggerAtMs: START + MINUTE }, { id: "a", triggerAtMs: START + 2 * MINUTE }] } })).status, 400);
  assert.equal((await h.api("PUT", path, { body: { alarms: [{ id: "a", triggerAtMs: START + MINUTE, title: "Standup" }] } })).status, 400);
  assert.equal((await h.api("PUT", path, { body: { alarms: [{ id: "a", triggerAtMs: "soon" }] } })).status, 400);
  const tooMany = Array.from({ length: 129 }, (_, index) => ({ id: `a${index}`, triggerAtMs: START + (index + 1) * MINUTE }));
  assert.equal((await h.api("PUT", path, { body: { alarms: tooMany } })).status, 400);
  assert.equal((await h.api("PUT", path, { body: { alarms: [] } })).status, 204);
  assert.deepEqual(h.install().alarms, []);
});

// --- Subscriptions -------------------------------------------------------------------------

test("subscription mappings store hashes only and enforce ownership and limits", async () => {
  const h = harness();
  await withGoogleSubscription(h);
  await withGraphSubscription(h);

  const google = h.subscription("google", CHANNEL_ID);
  assert.equal(google.installId, INSTALL_ID);
  assert.equal(google.resourceIdHash, sha256Hex(RESOURCE_ID));
  assert.equal(google.verificationHash, sha256Hex(CHANNEL_TOKEN));
  assert.equal(google.renewDueAtMs, google.expiresAtMs - 24 * 60 * MINUTE);
  const graph = h.subscription("microsoft", GRAPH_ID);
  assert.equal(graph.verificationHash, sha256Hex(CLIENT_STATE));
  const dump = JSON.stringify(h.db.dump());
  for (const secret of [CHANNEL_TOKEN, CLIENT_STATE, CHANNEL_ID, GRAPH_ID, RESOURCE_ID]) assert.equal(dump.includes(secret), false, secret);

  const base = `/v1/installations/${INSTALL_ID}/subscriptions`;
  const valid = { expiresAtMs: h.now + MINUTE, clientStateHash: sha256Hex("x") };
  assert.equal((await h.api("PUT", `${base}/microsoft/s1`, { body: { ...valid, clientStateHash: "nothex" } })).status, 400);
  assert.equal((await h.api("PUT", `${base}/microsoft/s1`, { body: { ...valid, expiresAtMs: h.now } })).status, 400);
  assert.equal((await h.api("PUT", `${base}/microsoft/s1`, { body: { ...valid, clientState: "raw" } })).status, 400);
  assert.equal((await h.api("PUT", `${base}/google/c1`, { body: { expiresAtMs: h.now + MINUTE, channelTokenHash: sha256Hex("x") } })).status, 400);

  // Another install cannot take over or delete the mapping.
  const otherId = "ZyXwVuTsRqPoNmLkJiHgFe";
  const otherSecret = "o".repeat(43);
  await h.api("POST", "/v1/installations", {
    auth: null,
    body: { installId: otherId, installSecret: otherSecret, apnsToken: APNS_TOKEN, environment: "development", heartbeat: HEARTBEAT },
  });
  const takeover = await h.api("PUT", `/v1/installations/${otherId}/subscriptions/microsoft/${GRAPH_ID}`, {
    auth: otherSecret,
    body: { expiresAtMs: h.now + MINUTE, clientStateHash: sha256Hex("attacker") },
  });
  assert.equal(takeover.status, 409);
  assert.equal((await h.api("DELETE", `/v1/installations/${otherId}/subscriptions/microsoft/${GRAPH_ID}`, { auth: otherSecret })).status, 204);
  assert.ok(h.subscription("microsoft", GRAPH_ID), "a foreign delete is a silent no-op");

  assert.equal((await h.api("DELETE", `${base}/microsoft/${GRAPH_ID}`)).status, 204);
  assert.equal(h.subscription("microsoft", GRAPH_ID), undefined);

  h.advance(MINUTE);
  const fresh = () => ({ expiresAtMs: h.now + 60 * MINUTE, clientStateHash: sha256Hex("x") });
  for (let index = 1; index < 64; index += 1) {
    if (index % 50 === 0) h.advance(MINUTE);
    assert.equal((await h.api("PUT", `${base}/microsoft/sub-${index}`, { body: fresh() })).status, 204, `sub-${index}`);
  }
  assert.equal((await h.api("PUT", `${base}/microsoft/one-too-many`, { body: fresh() })).status, 409);
  assert.equal((await h.api("PUT", `${base}/microsoft/sub-1`, { body: fresh() })).status, 204, "updating an existing mapping is allowed at the limit");
});

// --- Google webhook ------------------------------------------------------------------------

test("Google webhook validates the channel token and resource and sends a change push", async () => {
  const h = harness();
  await withGoogleSubscription(h);

  assert.equal((await h.google({ "x-goog-resource-state": "sync" })).status, 204);
  assert.equal(h.pushes.length, 0, "sync handshakes do not push");
  assert.equal((await h.google({ "x-goog-channel-token": "wrong" })).status, 403);
  assert.equal((await h.google({ "x-goog-channel-token": "" })).status, 403);
  assert.equal((await h.google({ "x-goog-resource-id": "other" })).status, 204);
  assert.equal((await h.google({ "x-goog-channel-id": "unknown-channel" })).status, 204);
  assert.equal((await h.google({ "x-goog-channel-id": "" })).status, 400);
  assert.equal(h.pushes.length, 0);

  assert.equal((await h.google()).status, 204);
  assert.equal(h.pushes.length, 1);
  assert.deepEqual(
    { kind: h.pushes[0].kind, provider: h.pushes[0].provider, installId: h.pushes[0].installId, at: h.pushes[0].at },
    { kind: "change", provider: "google", installId: INSTALL_ID, at: h.now },
  );
  assert.equal(h.install().lastPushAtMs, h.now);
  assert.equal(h.install().pendingChangeAtMs, null);

  const getRequest = await h.call("googleWebhookHandler", { method: "GET" });
  assert.equal(getRequest.status, 405);
});

test("Google webhook ignores expired channels", async () => {
  const h = harness();
  await withGoogleSubscription(h, START + 10 * MINUTE);
  h.advance(10 * MINUTE);
  assert.equal((await h.google()).status, 204);
  assert.equal(h.pushes.length, 0);
});

test("a change during the coalescing window is deferred, not dropped", async () => {
  const h = harness();
  await withGoogleSubscription(h);
  await h.google();
  h.advance(30 * 1000);
  assert.equal((await h.google()).status, 204);
  assert.equal(h.pushes.length, 1, "second change is coalesced");
  assert.equal(h.install().pendingChangeAtMs, h.now);
  assert.equal(h.install().nextWakeAtMs, START + 2 * MINUTE);

  h.advance(60 * 1000);
  await h.service.scheduledPushes();
  assert.equal(h.pushes.length, 1, "still inside the window");
  h.setNow(START + 2 * MINUTE);
  const counts = await h.service.scheduledPushes();
  assert.equal(counts.sent, 1);
  assert.equal(h.pushes.length, 2);
  assert.equal(h.pushes[1].kind, "change");
  assert.equal(h.pushes[1].provider, "google");
  assert.equal(h.install().pendingChangeAtMs, null);
});

test("APNs 410 and BadDeviceToken disable the install; other errors back off and retry", async () => {
  for (const response of [{ status: 410, reason: "Unregistered" }, { status: 400, reason: "BadDeviceToken" }]) {
    const h = harness({ apns: () => response });
    await withGoogleSubscription(h);
    assert.equal((await h.google()).status, 204);
    const install = h.install();
    assert.equal(install.enabled, false);
    assert.equal(install.disabledReason, response.status === 410 ? "apns_unregistered" : "apns_bad_device_token");
    assert.equal(install.nextWakeAtMs, null);
    h.advance(5 * MINUTE);
    assert.equal((await h.google()).status, 204);
    assert.equal(h.pushes.length, 1, "disabled installs are not pushed");
  }

  const h = harness({ apns: (_request, count) => (count === 1 ? { status: 500, reason: "InternalServerError" } : { status: 200 }) });
  await withGoogleSubscription(h);
  assert.equal((await h.google()).status, 204, "the change stays pending, so the provider need not retry");
  const failed = h.install();
  assert.equal(failed.enabled, true);
  assert.equal(failed.failureCount, 1);
  assert.equal(failed.pushClaimId, null);
  assert.equal(failed.nextWakeAtMs, START + MINUTE);
  h.advance(MINUTE);
  await h.service.scheduledPushes();
  assert.equal(h.pushes.length, 2);
  assert.equal(h.pushes[1].kind, "change");
  assert.equal(h.install().failureCount, 0);
});

test("transport failures release the claim and keep the change pending", async () => {
  const h = harness({ apns: () => { throw new Error("socket hang up"); } });
  await withGoogleSubscription(h);
  assert.equal((await h.google()).status, 204);
  const install = h.install();
  assert.equal(install.pushClaimId, null);
  assert.equal(typeof install.pendingChangeAtMs, "number");
  assert.equal(install.retryAfterMs, START + MINUTE);
});

test("a 410 for an old token does not disable an install that re-registered a new token", async () => {
  const h = harness();
  await h.register();
  const original = h.install();
  // Simulate a re-registration racing an in-flight push.
  await h.store.planAndClaim(INSTALL_ID, [], START + 20 * MINUTE, "in-flight");
  await h.store.updateRegistration(INSTALL_ID, { apnsToken: "cd".repeat(32), apnsEnvironment: "development", heartbeat: HEARTBEAT }, START + 20 * MINUTE);
  const disabled = await h.store.disableInstall(INSTALL_ID, "in-flight", original.apnsToken, "apns_unregistered", START + 20 * MINUTE);
  assert.equal(disabled, false);
  assert.equal(h.install().enabled, true);
  assert.equal(h.install().pushClaimId, null);
});

// --- Microsoft Graph webhook ---------------------------------------------------------------

test("Graph validation handshake echoes the token as text/plain for POST and GET", async () => {
  const h = harness();
  for (const method of ["POST", "GET"]) {
    const response = await h.call("microsoftWebhookHandler", { method, path: "/?validationToken=Validation%3A%20Testing%20client%20application" });
    assert.equal(response.status, 200);
    assert.equal(response.text, "Validation: Testing client application");
    assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
  }
  const tooLong = await h.call("microsoftWebhookHandler", { method: "POST", path: `/?validationToken=${"a".repeat(2049)}` });
  assert.equal(tooLong.status, 400);
  assert.equal((await h.call("microsoftWebhookHandler", { method: "GET", path: "/" })).status, 405);
});

test("Graph notifications are answered without calling APNs; the dispatch sends one change push", async () => {
  const h = harness({ apns: () => { throw new Error("the webhook must not call APNs"); } });
  await withGraphSubscription(h);
  const note = { subscriptionId: GRAPH_ID, clientState: CLIENT_STATE, changeType: "updated", resource: "me/events/AAA" };
  const response = await h.graph([note, { ...note, changeType: "created" }, { ...note, clientState: "forged" }]);
  assert.equal(response.status, 202);
  assert.equal(h.pushes.length, 0, "nothing is sent on the request path");
  assert.equal(h.install().pendingChangeProvider, "microsoft");
  assert.equal(h.dispatches().length, 1, "one dispatch per install, however many items");
  assert.equal(JSON.stringify(h.db.dump()).includes("me/events/AAA"), false, "resource paths are never stored");
});

test("Graph notifications check clientState, dedupe per install, and send one change push", async () => {
  const h = harness();
  await withGraphSubscription(h);
  const note = { subscriptionId: GRAPH_ID, clientState: CLIENT_STATE, changeType: "updated", resource: "me/events/AAA" };
  const response = await h.graph([note, { ...note, changeType: "created" }, { ...note, clientState: "forged" }]);
  assert.equal(response.status, 202);
  assert.deepEqual(await h.deliverDispatches(), ["sent"]);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0].kind, "change");
  assert.equal(h.pushes[0].provider, "microsoft");
  assert.deepEqual(h.dispatches(), [], "a delivered dispatch is deleted");
  assert.equal(h.install().pendingChangeAtMs, null);

  h.advance(5 * MINUTE);
  assert.equal((await h.graph([{ ...note, clientState: "forged" }, { ...note, subscriptionId: "unknown" }])).status, 202);
  assert.deepEqual(h.dispatches(), []);
  assert.equal((await h.graph([{ ...note, lifecycleEvent: "missed" }])).status, 202);
  assert.deepEqual(await h.deliverDispatches(), ["sent"]);
  assert.equal(h.pushes.length, 2);
  assert.equal(h.pushes[1].kind, "change");
});

test("Graph reauthorizationRequired and subscriptionRemoved trigger a renew push", async () => {
  for (const lifecycleEvent of ["reauthorizationRequired", "subscriptionRemoved"]) {
    const h = harness();
    await withGraphSubscription(h);
    const response = await h.graph([{ subscriptionId: GRAPH_ID, clientState: CLIENT_STATE, lifecycleEvent }]);
    assert.equal(response.status, 202);
    assert.equal(h.pushes.length, 0);
    assert.equal(h.subscription("microsoft", GRAPH_ID).renewalRequestedAtMs, h.now);
    assert.deepEqual(await h.deliverDispatches(), ["sent"]);
    assert.equal(h.pushes.length, 1, lifecycleEvent);
    assert.deepEqual([h.pushes[0].kind, h.pushes[0].provider], ["renew", "microsoft"]);
    const subscription = h.subscription("microsoft", GRAPH_ID);
    assert.equal(subscription.lastRenewPushAtMs, h.now);
    assert.equal(subscription.renewalRequestedAtMs, null);
    assert.equal(subscription.renewDueAtMs, h.now + 6 * 60 * MINUTE);
  }
});

test("a dispatch also covers renewals recorded after it was queued", async () => {
  const h = harness();
  await withGraphSubscription(h);
  const second = "second-graph-subscription";
  assert.equal((await h.api("PUT", `/v1/installations/${INSTALL_ID}/subscriptions/microsoft/${second}`, {
    body: { expiresAtMs: h.now + 3 * 24 * 60 * MINUTE, clientStateHash: sha256Hex(CLIENT_STATE) },
  })).status, 204);
  await h.graph([{ subscriptionId: GRAPH_ID, clientState: CLIENT_STATE, lifecycleEvent: "reauthorizationRequired" }]);
  h.advance(5 * 1000);
  await h.graph([{ subscriptionId: second, clientState: CLIENT_STATE, lifecycleEvent: "reauthorizationRequired" }]);
  assert.equal(h.dispatches().length, 1, "inside the dedupe window");
  assert.deepEqual(await h.deliverDispatches(), ["sent"]);
  assert.equal(h.pushes.length, 1);
  for (const id of [GRAPH_ID, second]) {
    assert.equal(h.subscription("microsoft", id).renewalRequestedAtMs, null, `${id} was covered by the one renew push`);
  }
});

test("a lost or failed dispatch is covered by the scheduler; duplicates send nothing extra", async () => {
  const h = harness();
  await withGraphSubscription(h);
  await h.graph([{ subscriptionId: GRAPH_ID, clientState: CLIENT_STATE }]);
  const [queued] = h.dispatches();
  // Eventarc never delivers it: the next scheduler pass sends the change.
  h.advance(MINUTE);
  const counts = await h.service.scheduledPushes();
  assert.equal(counts.sent, 1);
  assert.deepEqual([h.pushes[0].kind, h.pushes[0].provider], ["change", "microsoft"]);
  // A late (or duplicate at-least-once) delivery of the same dispatch finds nothing to send.
  const { id, ...data } = queued;
  assert.equal(await h.service.deliverDispatch(id, data), "idle");
  assert.equal(h.pushes.length, 1);
  assert.deepEqual(h.dispatches(), []);

  // Malformed dispatch documents are dropped without touching any install.
  assert.equal(await h.service.deliverDispatch("0".repeat(32), { installId: "../x", renewalKeys: [] }), "invalid");
  assert.equal(await h.service.deliverDispatch("0".repeat(32), { installId: INSTALL_ID, renewalKeys: ["iosPushInstalls/x"] }), "invalid");
  assert.equal(await h.service.deliverDispatch("0".repeat(32), null), "invalid");
});

test("a transient APNs failure during a dispatch backs off and the scheduler retries", async () => {
  const h = harness({ apns: (_request, count) => (count === 1 ? { status: 503, reason: "ServiceUnavailable" } : { status: 200 }) });
  await withGraphSubscription(h);
  await h.graph([{ subscriptionId: GRAPH_ID, clientState: CLIENT_STATE }]);
  assert.deepEqual(await h.deliverDispatches(), ["failed"]);
  assert.equal(h.install().pendingChangeProvider, "microsoft", "the change stays pending");
  h.advance(MINUTE);
  assert.equal((await h.service.scheduledPushes()).sent, 1);
  assert.equal(h.pushes.length, 2);
  assert.equal(h.install().pendingChangeAtMs, null);
});

test("Graph notifications inside the coalescing window are deferred to the scheduler", async () => {
  const h = harness();
  await withGraphSubscription(h);
  await h.graph([{ subscriptionId: GRAPH_ID, clientState: CLIENT_STATE }]);
  await h.deliverDispatches();
  h.advance(30 * 1000);
  await h.graph([{ subscriptionId: GRAPH_ID, clientState: CLIENT_STATE }]);
  assert.deepEqual(h.dispatches(), [], "no dispatch while coalescing blocks a push");
  h.advance(90 * 1000);
  assert.equal((await h.service.scheduledPushes()).sent, 1);
  assert.equal(h.pushes.length, 2);
  assert.equal(h.pushes[1].kind, "change");
});

test("Graph rejects malformed and oversized batches and ignores expired subscriptions", async () => {
  const h = harness();
  await withGraphSubscription(h, START + MINUTE);
  const tooManySubscriptions = Array.from({ length: 101 }, (_, index) => ({ subscriptionId: `s${index}`, clientState: "x" }));
  assert.equal((await h.graph(tooManySubscriptions)).status, 400);
  assert.equal((await h.call("microsoftWebhookHandler", { method: "POST", body: "{nope" })).status, 400);
  assert.equal((await h.call("microsoftWebhookHandler", { method: "POST", body: { value: "x" } })).status, 400);
  assert.equal((await h.call("microsoftWebhookHandler", { method: "POST", body: "x".repeat(1024 * 1024 + 1) })).status, 413);
  h.advance(MINUTE);
  assert.equal((await h.graph([{ subscriptionId: GRAPH_ID, clientState: CLIENT_STATE }])).status, 202);
  assert.deepEqual(h.dispatches(), []);
  await h.deliverDispatches();
  assert.equal(h.pushes.length, 0);
});

test("Graph lifecycle events after the recorded expiry still reach the device", async () => {
  const h = harness();
  const expiresAtMs = START + 30 * MINUTE;
  await withGraphSubscription(h, expiresAtMs);
  h.setNow(expiresAtMs + 60 * MINUTE);
  await h.service.scheduledPushes();
  h.advance(3 * MINUTE);
  const before = h.pushes.length;

  // A forged clientState is still rejected for an expired mapping.
  await h.graph([{ subscriptionId: GRAPH_ID, clientState: "forged", lifecycleEvent: "reauthorizationRequired" }]);
  assert.deepEqual(h.dispatches(), []);

  await h.graph([{ subscriptionId: GRAPH_ID, clientState: CLIENT_STATE, lifecycleEvent: "reauthorizationRequired" }]);
  assert.deepEqual(await h.deliverDispatches(), ["sent"]);
  assert.deepEqual([h.pushes[before].kind, h.pushes[before].provider], ["renew", "microsoft"]);
  const subscription = h.subscription("microsoft", GRAPH_ID);
  assert.equal(subscription.renewalRequestedAtMs, null);
  assert.equal(subscription.renewDueAtMs, null, "one prompt per lifecycle event once expired");

  h.advance(5 * MINUTE);
  await h.graph([{ subscriptionId: GRAPH_ID, clientState: CLIENT_STATE, lifecycleEvent: "missed" }]);
  assert.deepEqual(await h.deliverDispatches(), ["sent"]);
  assert.equal(h.pushes.at(-1).kind, "change");

  h.advance(5 * MINUTE);
  await h.graph([{ subscriptionId: GRAPH_ID, clientState: CLIENT_STATE, changeType: "updated" }]);
  assert.deepEqual(h.dispatches(), [], "plain change notifications for an expired mapping stay ignored");
  h.advance(10 * MINUTE);
  await h.service.scheduledPushes();
  assert.equal(h.pushes.filter((push) => push.kind === "renew").length, 1);
});

// --- Scheduler -----------------------------------------------------------------------------

test("heartbeats follow the interval, skip after other pushes, and respect active hours", async () => {
  const h = harness();
  await h.register();
  h.advance(19 * MINUTE);
  await h.service.scheduledPushes();
  assert.equal(h.pushes.length, 0);
  h.advance(MINUTE);
  await h.service.scheduledPushes();
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0].kind, "heartbeat");
  assert.equal(h.install().nextWakeAtMs, h.now + 20 * MINUTE);

  // A provider change resets the heartbeat timer.
  await withGoogleSubscription(h);
  h.advance(10 * MINUTE);
  await h.google();
  assert.equal(h.pushes.length, 2);
  h.advance(10 * MINUTE);
  await h.service.scheduledPushes();
  assert.equal(h.pushes.length, 2, "heartbeat skipped: a change push went out 10 minutes ago");

  // No heartbeats at night; the next one waits for 07:00 local.
  h.setNow(Date.parse("2026-10-08T05:00:00Z")); // 22:00 PDT
  await h.service.scheduledPushes();
  assert.equal(h.pushes.length, 2);
  assert.equal(h.install().nextWakeAtMs, Date.parse("2026-10-08T14:00:00Z"));
  h.setNow(Date.parse("2026-10-08T14:00:00Z"));
  await h.service.scheduledPushes();
  assert.equal(h.pushes.length, 3);
  assert.equal(h.pushes[2].kind, "heartbeat");
});

test("prechecks go out once at T-20 and T-8, even outside active hours", async () => {
  const h = harness();
  h.setNow(Date.parse("2026-10-08T07:00:00Z")); // 00:00 PDT
  await h.register();
  const trigger = h.now + 60 * MINUTE;
  await h.api("PUT", `/v1/installations/${INSTALL_ID}/alarms`, { body: { alarms: [{ id: "alarm-1", triggerAtMs: trigger }] } });
  assert.equal(h.install().nextWakeAtMs, trigger - 20 * MINUTE);

  for (let minute = 0; minute < 60; minute += 1) {
    await h.service.scheduledPushes();
    h.advance(MINUTE);
  }
  assert.deepEqual(h.pushes.map((push) => [push.kind, push.at - trigger]), [
    ["precheck", -20 * MINUTE],
    ["precheck", -8 * MINUTE],
  ]);
  assert.deepEqual(Object.keys(h.install().alarms[0].sent).sort(), ["t20", "t8"]);
});

test("a heartbeat due just before a precheck stage goes out as a priority-10 precheck", async () => {
  const h = harness();
  await h.register();
  const trigger = h.now + 41 * MINUTE;
  await h.api("PUT", `/v1/installations/${INSTALL_ID}/alarms`, { body: { alarms: [{ id: "a", triggerAtMs: trigger }] } });
  for (let minute = 0; minute < 41; minute += 1) {
    await h.service.scheduledPushes();
    h.advance(MINUTE);
  }
  assert.deepEqual(h.pushes.map((push) => [push.kind, (push.at - trigger) / MINUTE]), [
    ["precheck", -21],
    ["precheck", -8],
  ]);
});

test("re-uploading an unchanged alarm keeps its sent stages; moving it resets them", async () => {
  const h = harness();
  await h.register();
  const trigger = h.now + 30 * MINUTE;
  const path = `/v1/installations/${INSTALL_ID}/alarms`;
  await h.api("PUT", path, { body: { alarms: [{ id: "alarm-1", triggerAtMs: trigger }] } });
  h.advance(10 * MINUTE);
  await h.service.scheduledPushes();
  assert.equal(h.pushes.length, 1);
  await h.api("PUT", path, { body: { alarms: [{ id: "alarm-1", triggerAtMs: trigger }] } });
  assert.equal(typeof h.install().alarms[0].sent.t20, "number");
  await h.api("PUT", path, { body: { alarms: [{ id: "alarm-1", triggerAtMs: trigger + 5 * MINUTE }] } });
  assert.deepEqual(h.install().alarms[0].sent, {});
});

test("pushes are coalesced to one per install per two minutes, keeping the most urgent", async () => {
  const h = harness();
  await h.register();
  // Heartbeat and a T-20 precheck both due at the same minute.
  h.advance(20 * MINUTE);
  await h.api("PUT", `/v1/installations/${INSTALL_ID}/alarms`, {
    body: { alarms: [{ id: "a", triggerAtMs: h.now + 20 * MINUTE }, { id: "b", triggerAtMs: h.now + 21 * MINUTE }] },
  });
  await h.service.scheduledPushes();
  assert.deepEqual(h.pushes.map((push) => push.kind), ["precheck"]);
  // Alarm b's T-20 window opens one minute later; the push that just went out covers it.
  assert.equal(typeof h.install().alarms[1].sent.t20, "number");
  for (let minute = 0; minute < 3; minute += 1) {
    h.advance(MINUTE);
    await h.service.scheduledPushes();
  }
  assert.equal(h.pushes.length, 1);
});

test("subscriptions get a renew push 24 hours before expiry, retried until renewed", async () => {
  const h = harness();
  const expiresAtMs = START + 30 * 60 * MINUTE;
  await withGoogleSubscription(h, expiresAtMs);
  h.setNow(expiresAtMs - 24 * 60 * MINUTE);
  const pushesBefore = h.pushes.length;
  await h.service.scheduledPushes();
  const renewPushes = () => h.pushes.slice(pushesBefore).filter((push) => push.kind === "renew");
  assert.equal(renewPushes().length, 1);
  assert.equal(renewPushes()[0].provider, "google");
  assert.equal(h.subscription("google", CHANNEL_ID).renewDueAtMs, h.now + 6 * 60 * MINUTE);

  h.advance(3 * 60 * MINUTE);
  await h.service.scheduledPushes();
  assert.equal(renewPushes().length, 1, "no repeat before the retry time");
  h.advance(3 * 60 * MINUTE);
  await h.service.scheduledPushes();
  assert.equal(renewPushes().length, 2, "the device did not renew, so ask again");

  // The device renews (Google issues a new channel and the old mapping is replaced).
  await h.api("DELETE", `/v1/installations/${INSTALL_ID}/subscriptions/google/${CHANNEL_ID}`);
  await h.api("PUT", `/v1/installations/${INSTALL_ID}/subscriptions/google/new-channel`, {
    body: { resourceId: RESOURCE_ID, expiresAtMs: h.now + 7 * 24 * 60 * MINUTE, channelTokenHash: sha256Hex("t2") },
  });
  h.advance(6 * 60 * MINUTE);
  await h.service.scheduledPushes();
  assert.equal(renewPushes().length, 2);
});

test("scheduler reads only due installs and stops at its deadline", async () => {
  const h = harness();
  await h.register();
  for (let index = 0; index < 5; index += 1) {
    const id = `Install${String(index).padStart(15, "0")}`;
    await h.api("POST", "/v1/installations", {
      auth: null,
      headers: { "x-forwarded-for": `192.0.2.${index + 10}` },
      body: { installId: id, installSecret: SECRET, apnsToken: APNS_TOKEN, environment: "development", heartbeat: HEARTBEAT },
    });
  }
  const readsBefore = h.db.reads;
  const idle = await h.service.scheduledPushes();
  assert.equal(idle.installs, 0);
  assert.ok(h.db.reads - readsBefore <= 7, `an idle pass costs only its queries (${h.db.reads - readsBefore} reads)`);

  h.advance(20 * MINUTE);
  const partial = await h.service.scheduledPushes({ deadlineMs: h.now });
  assert.equal(partial.installs, 6);
  assert.equal(partial.skipped, 6);
  const full = await h.service.scheduledPushes();
  assert.equal(full.sent, 6);
});

test("installs with an alarm due go first, so a flood of heartbeat-only installs can't delay them", async () => {
  let h;
  // Each push takes long enough that the pass runs out of time after the first few.
  h = harness({ apns: () => { h.advance(MINUTE); return { status: 200 }; } });
  const flood = Array.from({ length: 40 }, (_, index) => `Flood${String(index).padStart(17, "0")}`);
  for (const [index, id] of flood.entries()) {
    const response = await h.api("POST", "/v1/installations", {
      auth: null,
      headers: { "x-forwarded-for": `203.0.113.${index}` },
      body: { installId: id, installSecret: SECRET, apnsToken: APNS_TOKEN, environment: "development", heartbeat: HEARTBEAT },
    });
    assert.equal(response.status, 201);
  }
  await h.register();
  const trigger = h.now + 60 * MINUTE;
  await h.api("PUT", `/v1/installations/${INSTALL_ID}/alarms`, { body: { alarms: [{ id: "alarm-1", triggerAtMs: trigger }] } });
  assert.equal(h.install().priorityWakeAtMs, trigger - 20 * MINUTE);
  assert.equal(h.install(flood[0]).priorityWakeAtMs, null, "heartbeats alone are not a priority");
  // Every flood install has been due longer than the alarm's precheck.
  h.setNow(trigger - 19 * MINUTE);
  const pass = await h.service.scheduledPushes({ deadlineMs: h.now + 30 * 1000 });
  assert.ok(pass.skipped > 0, "the pass ran out of time");
  assert.ok(h.pushes.some((push) => push.kind === "precheck"), "the precheck still went out");
  assert.equal(h.install().priorityWakeAtMs, trigger - 8 * MINUTE, "the next stage is the next priority");
});

test("new installs are capped overall; installs already registered can always re-register", async () => {
  const h = harness();
  assert.equal((await h.register()).status, 201);
  h.db.documents.set(`${COLLECTIONS.rateLimits}/${sha256Hex("registration:new-installs")}`, {
    windowStartMs: h.now, count: NEW_INSTALL_RATE.limit, expiresAt: new Date(h.now + NEW_INSTALL_RATE.windowMs),
  });
  const other = await h.api("POST", "/v1/installations", {
    auth: null,
    headers: { "x-forwarded-for": "192.0.2.99" },
    body: { installId: "ZyXwVuTsRqPoNmLkJiHgFe", installSecret: SECRET, apnsToken: APNS_TOKEN, environment: "development", heartbeat: HEARTBEAT },
  });
  assert.equal(other.status, 429);
  assert.equal((await h.register({ apnsToken: "cd".repeat(32) })).status, 200);
  h.advance(NEW_INSTALL_RATE.windowMs);
  assert.equal((await h.api("POST", "/v1/installations", {
    auth: null,
    headers: { "x-forwarded-for": "192.0.2.99" },
    body: { installId: "ZyXwVuTsRqPoNmLkJiHgFe", installSecret: SECRET, apnsToken: APNS_TOKEN, environment: "development", heartbeat: HEARTBEAT },
  })).status, 201);
});

test("persisted state never contains calendar content, raw secrets, or provider tokens", async () => {
  const h = harness();
  await withGoogleSubscription(h);
  await withGraphSubscription(h);
  await h.api("PUT", `/v1/installations/${INSTALL_ID}/alarms`, { body: { alarms: [{ id: "opaque-occurrence", triggerAtMs: START + 30 * MINUTE }] } });
  await h.google();
  h.advance(5 * MINUTE);
  await h.graph([{ subscriptionId: GRAPH_ID, clientState: CLIENT_STATE, resource: "Users/x/Events/y", resourceData: { id: "y" } }]);
  const dump = JSON.stringify(h.db.dump());
  for (const forbidden of [SECRET, CHANNEL_TOKEN, CLIENT_STATE, CHANNEL_ID, GRAPH_ID, "opaque-occurrence", "Events/y", "198.51.100.7"]) {
    assert.equal(dump.includes(forbidden), false, forbidden);
  }
});

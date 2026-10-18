"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http2 = require("node:http2");
const test = require("node:test");

const {
  APNS_HOSTS,
  ApnsConfigError,
  ProviderTokenCache,
  buildApnsRequest,
  buildPayload,
  createApnsSender,
  makeProviderToken,
  validateApnsConfig,
} = require("../ios-push-apns");

const INSTALL_ID = "AbCdEfGhIjKlMnOpQrStUv";
const INSTALL = { apnsToken: "ab".repeat(32), apnsEnvironment: "development" };
const AT = Date.parse("2026-10-07T16:00:00.000Z");

// Generated per run; never a real Apple key.
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const CONFIG = { keyPem: KEY_PEM, keyId: "ABC123DEFG", teamId: "TEAM123456", topic: "com.example.alwaysontime" };

function decodeJwt(token) {
  const [header, claims, signature] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header, "base64url")),
    claims: JSON.parse(Buffer.from(claims, "base64url")),
    signingInput: `${header}.${claims}`,
    signature: Buffer.from(signature, "base64url"),
  };
}

/** Local cleartext HTTP/2 server standing in for APNs. */
async function startFakeApns(respond) {
  const requests = [];
  const sessions = new Set();
  const server = http2.createServer();
  server.on("session", (session) => sessions.add(session));
  server.on("stream", (stream, headers) => {
    stream.on("error", () => {}); // resets initiated by this fake surface here
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { body += chunk; });
    stream.on("end", () => {
      const request = { headers, body: JSON.parse(body) };
      requests.push(request);
      const { status = 200, reason, close = false, reset = false } = respond(request, requests.length) ?? {};
      if (close) {
        stream.session.destroy();
        return;
      }
      if (reset) {
        stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);
        return;
      }
      stream.respond({ ":status": status, "apns-id": headers["apns-id"] });
      stream.end(reason ? JSON.stringify({ reason }) : "");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    requests,
    sessions,
    connect: () => http2.connect(origin),
    close: () => new Promise((resolve) => {
      for (const session of sessions) session.destroy();
      server.close(resolve);
    }),
  };
}

test("payload v1 is passive, mutable, content free, and validates kind and provider", () => {
  assert.deepEqual(buildPayload({ kind: "change", provider: "google", at: AT }), {
    aps: {
      alert: { title: "Keeping your alarms up to date", body: "Checking for calendar updates." },
      "mutable-content": 1,
      "interruption-level": "passive",
    },
    aot: { v: 1, kind: "change", provider: "google", at: AT },
  });
  for (const kind of ["heartbeat", "precheck", "renew"]) {
    assert.deepEqual(buildPayload({ kind, at: AT }).aot, { v: 1, kind, at: AT });
  }
  assert.throws(() => buildPayload({ kind: "sync", at: AT }), TypeError);
  assert.throws(() => buildPayload({ kind: "change", provider: "icloud", at: AT }), TypeError);
  assert.throws(() => buildPayload({ kind: "change", at: 1.5 }), TypeError);
});

test("APNs request headers: alert type, one collapse id per install, priority by kind", () => {
  const priorities = {};
  for (const kind of ["change", "heartbeat", "precheck", "renew"]) {
    const request = buildApnsRequest({ installId: INSTALL_ID, install: INSTALL, kind, at: AT, topic: CONFIG.topic });
    priorities[kind] = request.headers["apns-priority"];
    assert.equal(request.origin, APNS_HOSTS.development);
    assert.equal(request.path, `/3/device/${INSTALL.apnsToken}`);
    assert.equal(request.headers["apns-push-type"], "alert");
    assert.equal(request.headers["apns-collapse-id"], `aot-${INSTALL_ID}`);
    assert.equal(request.headers["apns-topic"], CONFIG.topic);
    assert.equal(request.headers["apns-expiration"], String(AT / 1000 + 86400));
    assert.match(request.headers["apns-id"], /^[0-9a-f-]{36}$/);
  }
  assert.deepEqual(priorities, { change: "10", heartbeat: "5", precheck: "10", renew: "10" });
  const production = buildApnsRequest({
    installId: INSTALL_ID,
    install: { ...INSTALL, apnsEnvironment: "production" },
    kind: "heartbeat",
    at: AT,
    topic: CONFIG.topic,
  });
  assert.equal(production.origin, "https://api.push.apple.com");
  assert.throws(() => buildApnsRequest({ installId: "short", install: INSTALL, kind: "change", at: AT, topic: "a.b" }), TypeError);
  assert.throws(() => buildApnsRequest({ installId: INSTALL_ID, install: { ...INSTALL, apnsToken: "XYZ" }, kind: "change", at: AT, topic: "a.b" }), TypeError);
});

test("ES256 provider token has the APNs header and claims and verifies with the public key", () => {
  const config = validateApnsConfig(CONFIG);
  const token = makeProviderToken(config, 1_791_403_200);
  const { header, claims, signingInput, signature } = decodeJwt(token);
  assert.deepEqual(header, { alg: "ES256", kid: "ABC123DEFG" });
  assert.deepEqual(claims, { iss: "TEAM123456", iat: 1_791_403_200 });
  assert.equal(signature.length, 64, "JOSE ES256 signatures are raw r||s, not DER");
  assert.equal(crypto.verify("sha256", Buffer.from(signingInput), { key: publicKey, dsaEncoding: "ieee-p1363" }, signature), true);
});

test("provider tokens are reused for 40 minutes and invalidated no faster than every 20", () => {
  let clock = AT;
  const cache = new ProviderTokenCache(validateApnsConfig(CONFIG), { now: () => clock });
  const first = cache.get();
  clock += 39 * 60 * 1000;
  assert.equal(cache.get(), first);
  clock += 60 * 1000;
  const second = cache.get();
  assert.notEqual(second, first);
  clock += 10 * 60 * 1000;
  cache.invalidate();
  assert.equal(cache.get(), second, "refreshing within 20 minutes would trigger TooManyProviderTokenUpdates");
  clock += 10 * 60 * 1000;
  cache.invalidate();
  assert.notEqual(cache.get(), second);
});

test("APNs config rejects missing or malformed credentials without echoing them", () => {
  assert.throws(() => validateApnsConfig({ ...CONFIG, keyPem: "" }), ApnsConfigError);
  assert.throws(() => validateApnsConfig({ ...CONFIG, keyPem: "-----BEGIN PRIVATE KEY-----\nnope" }), /not a readable private key/);
  // Well-formed keys of the wrong type or curve: APNs ES256 needs EC P-256.
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  assert.throws(() => validateApnsConfig({ ...CONFIG, keyPem: rsa }), /EC P-256/);
  const p384 = crypto.generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey.export({ type: "pkcs8", format: "pem" });
  assert.throws(() => validateApnsConfig({ ...CONFIG, keyPem: p384 }), /EC P-256/);
  assert.throws(() => validateApnsConfig({ ...CONFIG, keyId: "abc" }), /APNS_KEY_ID/);
  assert.throws(() => validateApnsConfig({ ...CONFIG, teamId: "abc" }), /APNS_TEAM_ID/);
  assert.throws(() => validateApnsConfig({ ...CONFIG, topic: "com.example.app.voip" }), /APNS_TOPIC/);
  try {
    validateApnsConfig({ ...CONFIG, keyPem: "secret-material" });
  } catch (error) {
    assert.doesNotMatch(error.message, /secret-material/);
  }
});

test("HTTP/2 sender posts the payload with a bearer JWT and reuses one connection", async (t) => {
  const apns = await startFakeApns(() => ({ status: 200 }));
  t.after(apns.close);
  const send = createApnsSender({ ...CONFIG, connect: apns.connect, now: () => AT });
  t.after(() => send.close());

  const first = await send({ installId: INSTALL_ID, install: INSTALL, kind: "precheck", at: AT });
  const second = await send({ installId: INSTALL_ID, install: INSTALL, kind: "heartbeat", at: AT });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(apns.sessions.size, 1, "both pushes share one HTTP/2 connection");

  const [request] = apns.requests;
  assert.equal(request.headers[":method"], "POST");
  assert.equal(request.headers[":path"], `/3/device/${INSTALL.apnsToken}`);
  assert.equal(request.headers["apns-push-type"], "alert");
  assert.equal(request.headers["apns-priority"], "10");
  assert.equal(apns.requests[1].headers["apns-priority"], "5");
  assert.equal(request.headers["apns-collapse-id"], `aot-${INSTALL_ID}`);
  assert.deepEqual(request.body.aot, { v: 1, kind: "precheck", at: AT });
  const jwt = decodeJwt(request.headers.authorization.replace(/^bearer /, ""));
  assert.deepEqual(jwt.claims, { iss: CONFIG.teamId, iat: AT / 1000 });
});

test("HTTP/2 sender returns APNs rejections and refreshes the token after ExpiredProviderToken", async (t) => {
  let clock = AT;
  const apns = await startFakeApns((_request, count) => (
    count === 1 ? { status: 410, reason: "Unregistered" }
      : count === 2 ? { status: 403, reason: "ExpiredProviderToken" }
        : { status: 200 }
  ));
  t.after(apns.close);
  const send = createApnsSender({ ...CONFIG, connect: apns.connect, now: () => clock });
  t.after(() => send.close());

  assert.deepEqual(
    pick(await send({ installId: INSTALL_ID, install: INSTALL, kind: "change", at: AT })),
    { status: 410, reason: "Unregistered" },
  );
  clock += 25 * 60 * 1000;
  assert.equal((await send({ installId: INSTALL_ID, install: INSTALL, kind: "change", at: AT })).status, 403);
  await send({ installId: INSTALL_ID, install: INSTALL, kind: "change", at: AT });
  const tokens = apns.requests.map((request) => request.headers.authorization);
  assert.equal(tokens[0], tokens[1]);
  assert.notEqual(tokens[2], tokens[1], "a rejected provider token is replaced");
});

test("HTTP/2 sender retries once on a fresh connection when the connection drops", async (t) => {
  const apns = await startFakeApns((_request, count) => (count === 1 ? { close: true } : { status: 200 }));
  t.after(apns.close);
  const send = createApnsSender({ ...CONFIG, connect: apns.connect, now: () => AT });
  t.after(() => send.close());
  const result = await send({ installId: INSTALL_ID, install: INSTALL, kind: "change", at: AT });
  assert.equal(result.status, 200);
  assert.equal(apns.requests.length, 2);
});

test("a reset stream is retried on the same connection instead of tearing it down", async (t) => {
  const apns = await startFakeApns((_request, count) => (count === 1 ? { reset: true } : { status: 200 }));
  t.after(apns.close);
  const send = createApnsSender({ ...CONFIG, connect: apns.connect, now: () => AT });
  t.after(() => send.close());
  const result = await send({ installId: INSTALL_ID, install: INSTALL, kind: "change", at: AT });
  assert.equal(result.status, 200);
  assert.equal(apns.requests.length, 2);
  assert.equal(apns.sessions.size, 1);
});

test("HTTP/2 sender rejects after the retry also fails", async (t) => {
  const apns = await startFakeApns(() => ({ close: true }));
  t.after(apns.close);
  const send = createApnsSender({ ...CONFIG, connect: apns.connect, now: () => AT });
  t.after(() => send.close());
  await assert.rejects(send({ installId: INSTALL_ID, install: INSTALL, kind: "change", at: AT }));
  assert.equal(apns.requests.length, 2);
});

function pick({ status, reason }) {
  return { status, reason };
}

"use strict";

const crypto = require("node:crypto");
const http2 = require("node:http2");

const APNS_HOSTS = Object.freeze({
  development: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
});
const PUSH_KINDS = new Set(["change", "heartbeat", "precheck", "renew"]);
const PROVIDERS = new Set(["google", "microsoft"]);
const MAX_PAYLOAD_BYTES = 4096;
const PAYLOAD_VERSION = 1;
// APNs keeps only the newest undelivered notification per device and collapse ID, so a long
// expiry costs nothing and lets an offline device catch up once it reconnects.
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
// Apple rejects provider tokens older than an hour and throttles refreshes more often than every
// 20 minutes.
const PROVIDER_TOKEN_MAX_AGE_MS = 40 * 60 * 1000;
const PROVIDER_TOKEN_MIN_AGE_MS = 20 * 60 * 1000;
const PROVIDER_TOKEN_ERRORS = new Set(["ExpiredProviderToken", "InvalidProviderToken"]);

class ApnsConfigError extends Error {}

function validateApnsConfig({ keyPem, keyId, teamId, topic }) {
  if (typeof keyPem !== "string" || keyPem.length === 0) {
    throw new ApnsConfigError("APNS_AUTH_KEY_P8 is missing");
  }
  if (!/^[A-Z0-9]{10}$/.test(keyId ?? "")) {
    throw new ApnsConfigError("APNS_KEY_ID must be 10 uppercase alphanumerics");
  }
  if (!/^[A-Z0-9]{10}$/.test(teamId ?? "")) {
    throw new ApnsConfigError("APNS_TEAM_ID must be 10 uppercase alphanumerics");
  }
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(topic ?? "") ||
      /\.(voip|complication|pushkit\..*|push-type\..*)$/i.test(topic)) {
    throw new ApnsConfigError("APNS_TOPIC must be the app bundle identifier");
  }

  let key;
  try {
    key = crypto.createPrivateKey(keyPem);
  } catch (_error) {
    throw new ApnsConfigError("APNS_AUTH_KEY_P8 is not a readable private key");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new ApnsConfigError("APNS_AUTH_KEY_P8 must be an EC P-256 key");
  }
  return { key, keyId, teamId, topic };
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

/** ES256 provider token: header {alg, kid}, claims {iss, iat}. */
function makeProviderToken({ key, keyId, teamId }, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const claims = base64url(JSON.stringify({ iss: teamId, iat: nowSeconds }));
  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${signature.toString("base64url")}`;
}

class ProviderTokenCache {
  constructor(config, { now = () => Date.now() } = {}) {
    this.config = config;
    this.now = now;
    this.token = null;
    this.issuedAtMs = 0;
  }

  get() {
    const nowMs = this.now();
    if (!this.token || nowMs - this.issuedAtMs >= PROVIDER_TOKEN_MAX_AGE_MS) {
      this.token = makeProviderToken(this.config, Math.floor(nowMs / 1000));
      this.issuedAtMs = nowMs;
    }
    return this.token;
  }

  /** Drops a token APNs rejected, without refreshing faster than Apple allows. */
  invalidate() {
    if (this.now() - this.issuedAtMs >= PROVIDER_TOKEN_MIN_AGE_MS) this.token = null;
  }
}

function buildPayload({ kind, provider, at }) {
  if (!PUSH_KINDS.has(kind)) throw new TypeError("unsupported push kind");
  if (provider !== undefined && !PROVIDERS.has(provider)) throw new TypeError("unsupported push provider");
  if (!Number.isSafeInteger(at) || at < 0) throw new TypeError("at must be epoch milliseconds");
  return {
    aps: {
      alert: {
        title: "Keeping your alarms up to date",
        body: "Checking for calendar updates.",
      },
      "mutable-content": 1,
      "interruption-level": "passive",
    },
    aot: {
      v: PAYLOAD_VERSION,
      kind,
      ...(provider ? { provider } : {}),
      at,
    },
  };
}

function apnsPriority(kind) {
  return kind === "heartbeat" ? "5" : "10";
}

// Every relay push, and every assistant push that shows no alert of its own, replaces the same
// quiet notification on the device (docs/IOS_PUSH_PROTOCOL.md section 5).
const SYNC_COLLAPSE_ID = "aot-sync";

function collapseId() {
  return SYNC_COLLAPSE_ID;
}

function buildApnsRequest({ installId, install, kind, provider, at, topic, ttlSeconds = DEFAULT_TTL_SECONDS }) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(installId ?? "")) throw new TypeError("invalid install id");
  if (!/^[0-9a-f]{64,200}$/.test(install?.apnsToken ?? "")) throw new TypeError("invalid APNs token");
  if (!Object.hasOwn(APNS_HOSTS, install?.apnsEnvironment)) throw new TypeError("invalid APNs environment");
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 0 || ttlSeconds > 2_419_200) {
    throw new TypeError("invalid APNs expiration");
  }
  const body = JSON.stringify(buildPayload({ kind, provider, at }));
  if (Buffer.byteLength(body, "utf8") > MAX_PAYLOAD_BYTES) throw new TypeError("APNs payload exceeds 4 KB");
  return {
    origin: APNS_HOSTS[install.apnsEnvironment],
    path: `/3/device/${install.apnsToken}`,
    headers: {
      "apns-push-type": "alert",
      "apns-priority": apnsPriority(kind),
      "apns-collapse-id": collapseId(),
      "apns-topic": topic,
      "apns-id": crypto.randomUUID(),
      "apns-expiration": String(Math.floor(at / 1000) + ttlSeconds),
    },
    body,
  };
}

/**
 * Keeps one HTTP/2 connection per APNs origin, as Apple recommends, and reconnects after the
 * connection closes or fails.
 */
class Http2SessionPool {
  constructor({ connect = http2.connect, idleTimeoutMs = 5 * 60 * 1000 } = {}) {
    this.connect = connect;
    this.idleTimeoutMs = idleTimeoutMs;
    this.sessions = new Map();
  }

  get(origin) {
    const existing = this.sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = this.connect(origin);
    const forget = () => {
      if (this.sessions.get(origin) === session) this.sessions.delete(origin);
    };
    session.on("error", forget);
    session.on("goaway", forget);
    session.on("close", forget);
    if (typeof session.setTimeout === "function") {
      session.setTimeout(this.idleTimeoutMs, () => {
        forget();
        session.close();
      });
    }
    if (typeof session.unref === "function") session.unref();
    this.sessions.set(origin, session);
    return session;
  }

  discard(origin, session) {
    if (this.sessions.get(origin) === session) this.sessions.delete(origin);
    try { session.destroy(); } catch (_error) { /* already closed */ }
  }

  closeAll() {
    for (const session of this.sessions.values()) {
      try { session.close(); } catch (_error) { /* already closed */ }
    }
    this.sessions.clear();
  }
}

/** Sends one request on a pooled session. Resolves { status, apnsId, reason, timestamp }. */
function sendOnSession({ session, authorization, request, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let responded = false;
    let status = 0;
    let apnsId = request.headers["apns-id"];
    let data = "";
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) {
        error.responded = responded;
        reject(error);
      } else {
        resolve(result);
      }
    };

    let stream;
    try {
      stream = session.request({
        ":method": "POST",
        ":path": request.path,
        authorization: `bearer ${authorization}`,
        "content-type": "application/json",
        ...request.headers,
      });
    } catch (error) {
      finish(error);
      return;
    }
    stream.setTimeout(timeoutMs, () => {
      try { stream.close(http2.constants.NGHTTP2_CANCEL); } catch (_error) { /* closed */ }
      const error = new Error("APNs request timed out");
      error.timedOut = true;
      finish(error);
    });
    stream.on("response", (headers) => {
      responded = true;
      status = Number(headers[":status"] ?? 0);
      apnsId = headers["apns-id"] ?? apnsId;
    });
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      data += chunk;
      if (data.length > 8192) {
        try { stream.close(http2.constants.NGHTTP2_CANCEL); } catch (_error) { /* closed */ }
        finish(new Error("APNs response exceeded limit"));
      }
    });
    stream.on("end", () => {
      if (!responded) {
        finish(new Error("APNs connection closed before a response"));
        return;
      }
      let parsed = {};
      try { parsed = data ? JSON.parse(data) : {}; } catch (_error) { parsed = { reason: "UnparseableResponse" }; }
      finish(null, { status, apnsId, reason: parsed.reason, timestamp: parsed.timestamp });
    });
    stream.on("error", (error) => finish(error));
    stream.once("close", () => finish(new Error("APNs stream closed before a response")));
    stream.end(request.body);
  });
}

/**
 * Creates the APNs transport: `send({ environment, token, headers, body })` posts one alert push to
 * `token` on the given APNs environment and resolves with the APNs status and reason (200 means APNs
 * accepted the push, not that the device received it). It adds `apns-topic` and `apns-id` unless
 * `headers` has them. Rejects only for invalid input and transport failures. A request that fails
 * before APNs answered is retried once on a new connection, so every caller sends a collapse ID
 * that makes a duplicate harmless.
 */
function createApnsTransport({ keyPem, keyId, teamId, topic, connect, now = () => Date.now(), timeoutMs }) {
  const config = validateApnsConfig({ keyPem, keyId, teamId, topic });
  const tokenCache = new ProviderTokenCache(config, { now });
  const pool = new Http2SessionPool({ connect });

  async function send({ environment, token, headers = {}, body }) {
    if (!Object.hasOwn(APNS_HOSTS, environment)) throw new TypeError("invalid APNs environment");
    if (!/^[0-9a-f]{64,200}$/.test(token ?? "")) throw new TypeError("invalid APNs token");
    if (typeof body !== "string") throw new TypeError("APNs body must be a JSON string");
    if (Buffer.byteLength(body, "utf8") > MAX_PAYLOAD_BYTES) throw new TypeError("APNs payload exceeds 4 KB");
    const request = {
      origin: APNS_HOSTS[environment],
      path: `/3/device/${token}`,
      headers: { ...headers, "apns-topic": headers["apns-topic"] ?? config.topic, "apns-id": headers["apns-id"] ?? crypto.randomUUID() },
      body,
    };
    let result;
    for (let attempt = 0; ; attempt += 1) {
      const session = pool.get(request.origin);
      try {
        result = await sendOnSession({ session, authorization: tokenCache.get(), request, timeoutMs });
        break;
      } catch (error) {
        // Keep the shared connection for stream-level failures; drop it when the connection
        // itself failed or a request timed out (likely a dead connection).
        if (session.closed || session.destroyed || error.timedOut) pool.discard(request.origin, session);
        if (attempt > 0 || error.responded) throw error;
      }
    }
    if (result.status === 403 && PROVIDER_TOKEN_ERRORS.has(result.reason)) tokenCache.invalidate();
    return result;
  }

  return { topic: config.topic, send, close: () => pool.closeAll() };
}

/**
 * Creates the relay's `send({ installId, install, kind, provider, at })` on an APNs transport:
 * either `transport` or one built from the key options (`keyPem`, `keyId`, `teamId`, `topic`, ...).
 * A duplicate from the transport's retry is harmless because every relay push shares one collapse ID.
 */
function createApnsSender({ transport, ...options }) {
  const apns = transport ?? createApnsTransport(options);

  async function send({ installId, install, kind, provider, at }) {
    const request = buildApnsRequest({ installId, install, kind, provider, at, topic: apns.topic });
    return apns.send({ environment: install.apnsEnvironment, token: install.apnsToken, headers: request.headers, body: request.body });
  }

  send.close = () => apns.close();
  return send;
}

module.exports = {
  APNS_HOSTS,
  DEFAULT_TTL_SECONDS,
  Http2SessionPool,
  MAX_PAYLOAD_BYTES,
  PAYLOAD_VERSION,
  ApnsConfigError,
  ProviderTokenCache,
  SYNC_COLLAPSE_ID,
  apnsPriority,
  buildApnsRequest,
  buildPayload,
  collapseId,
  createApnsSender,
  createApnsTransport,
  makeProviderToken,
  sendOnSession,
  validateApnsConfig,
};

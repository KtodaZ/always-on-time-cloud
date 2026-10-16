"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
const {
  StoreError,
  alarmKey,
  safeEqualHex,
  sha256Hex,
  subscriptionDocumentId,
  MAX_SUBSCRIPTIONS_PER_INSTALL,
} = require("./ios-push-firestore");
const { isValidTimeZone } = require("./ios-push-schedule");

const MAX_API_BODY_BYTES = 32 * 1024;
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const MAX_ALARMS_PER_INSTALL = 128;
const MAX_ALARM_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SUBSCRIPTION_HORIZON_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_GRAPH_NOTIFICATIONS = 1000;
const MAX_GRAPH_SUBSCRIPTIONS_PER_REQUEST = 100;
const REGISTRATION_RATE = Object.freeze({ limit: 20, windowMs: 60 * 60 * 1000 });
const INSTALL_RATE = Object.freeze({ limit: 60, windowMs: 60 * 1000 });
const SCHEDULER_BATCH_LIMIT = 1000;
const SCHEDULER_CONCURRENCY = 16;
const WEBHOOK_CONCURRENCY = 8;
const PROVIDERS = new Set(["google", "microsoft"]);
const GRAPH_LIFECYCLE_EVENTS = new Set(["reauthorizationRequired", "subscriptionRemoved", "missed"]);
const DISPATCH_ID = /^[0-9a-f]{32}$/;
const SUBSCRIPTION_KEY = /^(?:google|microsoft)_[0-9a-f]{64}$/;
const ENVIRONMENTS = new Set(["development", "production"]);
const INSTALL_ID = /^[A-Za-z0-9_-]{22}$/;
const INSTALL_SECRET = /^[A-Za-z0-9_-]{43}$/;
const APNS_TOKEN = /^[0-9a-f]{64,200}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const silentLogger = { info() {}, warn() {}, error() {} };

function setHeader(res, name, value) {
  if (typeof res.setHeader === "function") res.setHeader(name, value);
}

function jsonResponse(res, status, value = null) {
  res.statusCode = status;
  setHeader(res, "cache-control", "no-store");
  if (value !== null) setHeader(res, "content-type", "application/json; charset=utf-8");
  res.end(value === null ? "" : JSON.stringify(value));
}

function textResponse(res, status, value) {
  res.statusCode = status;
  setHeader(res, "cache-control", "no-store");
  setHeader(res, "content-type", "text/plain; charset=utf-8");
  setHeader(res, "x-content-type-options", "nosniff");
  res.end(value);
}

function getHeader(req, name) {
  const target = name.toLowerCase();
  const entry = Object.entries(req.headers ?? {}).find(([key]) => key.toLowerCase() === target);
  const value = entry?.[1];
  return typeof value === "string" ? value : Array.isArray(value) ? String(value[0] ?? "") : "";
}

function requestUrl(req) {
  return new URL(req.originalUrl ?? req.url ?? "/", "https://functions.invalid");
}

function method(req) {
  return String(req.method ?? "GET").toUpperCase();
}

/** Parses the JSON body from the raw bytes when available so size limits are exact. */
function readJsonBody(req, maxBytes) {
  const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody
    : Buffer.isBuffer(req.body) ? req.body
      : typeof req.body === "string" ? Buffer.from(req.body, "utf8")
        : null;
  if (raw) {
    if (raw.length > maxBytes) throw new HttpError(413, "request body too large");
    if (raw.length === 0) throw new HttpError(400, "JSON object required");
    try {
      return JSON.parse(raw.toString("utf8"));
    } catch (_error) {
      throw new HttpError(400, "invalid JSON body");
    }
  }
  if (req.body && typeof req.body === "object") {
    if (Buffer.byteLength(JSON.stringify(req.body), "utf8") > maxBytes) throw new HttpError(413, "request body too large");
    return req.body;
  }
  throw new HttpError(400, "JSON object required");
}

function requireObject(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "JSON object required");
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new HttpError(400, `fields do not match the schema (missing: ${missing.join(",") || "none"}; unknown: ${unknown.join(",") || "none"})`);
  }
}

/** Provider identifiers: printable, no whitespace or path separators, at most 256 chars. */
function validProviderId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    /^[\x21-\x7e]+$/.test(value) && !/[/\\]/.test(value);
}

function validateHeartbeat(value) {
  requireObject(value, ["intervalMinutes", "activeHours", "timeZone"]);
  if (!Number.isInteger(value.intervalMinutes) || value.intervalMinutes < 15 || value.intervalMinutes > 30) {
    throw new HttpError(400, "heartbeat.intervalMinutes must be an integer from 15 to 30");
  }
  requireObject(value.activeHours, ["start", "end"]);
  const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  const { start, end } = value.activeHours;
  if (typeof start !== "string" || typeof end !== "string" || !clock.test(start) || !clock.test(end) || start === end) {
    throw new HttpError(400, "heartbeat.activeHours needs distinct HH:mm start and end");
  }
  if (!isValidTimeZone(value.timeZone)) throw new HttpError(400, "heartbeat.timeZone must be an IANA time zone");
  return { intervalMinutes: value.intervalMinutes, activeHours: { start, end }, timeZone: value.timeZone };
}

function validateRegistration(body) {
  if (typeof body.apnsToken !== "string" || !APNS_TOKEN.test(body.apnsToken)) {
    throw new HttpError(400, "apnsToken must be 64-200 lowercase hexadecimal characters");
  }
  if (!ENVIRONMENTS.has(body.environment)) throw new HttpError(400, "environment must be development or production");
  return {
    apnsToken: body.apnsToken,
    apnsEnvironment: body.environment,
    heartbeat: validateHeartbeat(body.heartbeat),
  };
}

/**
 * Alarm snapshot. Entries at or before `nowMs` or beyond 90 days are dropped rather than
 * rejected, so a snapshot racing an alarm's trigger still succeeds.
 */
function validateAlarms(body, nowMs) {
  requireObject(body, ["alarms"]);
  if (!Array.isArray(body.alarms) || body.alarms.length > MAX_ALARMS_PER_INSTALL) {
    throw new HttpError(400, `alarms must be an array of at most ${MAX_ALARMS_PER_INSTALL} entries`);
  }
  const seen = new Set();
  const alarms = [];
  for (const alarm of body.alarms) {
    requireObject(alarm, ["id", "triggerAtMs"]);
    if (typeof alarm.id !== "string" || alarm.id.length < 1 || alarm.id.length > 200 || /[\u0000-\u001f]/.test(alarm.id)) {
      throw new HttpError(400, "alarm id must be an opaque string of 1 to 200 characters");
    }
    if (!Number.isSafeInteger(alarm.triggerAtMs) || alarm.triggerAtMs < 0) {
      throw new HttpError(400, "triggerAtMs must be epoch milliseconds");
    }
    const key = alarmKey(alarm.id);
    if (seen.has(key)) throw new HttpError(400, "alarm ids must be unique");
    seen.add(key);
    if (alarm.triggerAtMs > nowMs && alarm.triggerAtMs <= nowMs + MAX_ALARM_HORIZON_MS) {
      alarms.push({ key, triggerAtMs: alarm.triggerAtMs });
    }
  }
  return alarms.sort((left, right) => left.triggerAtMs - right.triggerAtMs);
}

function validateSubscription(provider, body, nowMs) {
  const fields = provider === "google"
    ? ["resourceId", "expiresAtMs", "channelTokenHash"]
    : ["expiresAtMs", "clientStateHash"];
  requireObject(body, fields);
  const verificationHash = provider === "google" ? body.channelTokenHash : body.clientStateHash;
  if (typeof verificationHash !== "string" || !SHA256_HEX.test(verificationHash)) {
    throw new HttpError(400, `${provider === "google" ? "channelTokenHash" : "clientStateHash"} must be lowercase SHA-256 hex`);
  }
  if (provider === "google" && !validProviderId(body.resourceId)) throw new HttpError(400, "resourceId is invalid");
  if (!Number.isSafeInteger(body.expiresAtMs) || body.expiresAtMs <= nowMs || body.expiresAtMs > nowMs + MAX_SUBSCRIPTION_HORIZON_MS) {
    throw new HttpError(400, "expiresAtMs must be a future epoch time within 366 days");
  }
  return {
    provider,
    resourceId: provider === "google" ? body.resourceId : undefined,
    verificationHash,
    expiresAtMs: body.expiresAtMs,
  };
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch (_error) {
    return null;
  }
}

function parseApiRoute(pathname) {
  // Cloud Functions may or may not strip the function name from the path.
  const path = pathname.replace(/^\/iosPushApi(?=\/)/, "");
  if (path === "/v1/installations") return { kind: "collection" };
  const parts = path.split("/");
  if (parts.length < 4 || parts[0] !== "" || parts[1] !== "v1" || parts[2] !== "installations") return null;
  const installId = decodeSegment(parts[3]);
  if (!INSTALL_ID.test(installId ?? "")) return null;
  if (parts.length === 4) return { kind: "installation", installId };
  if (parts.length === 5 && parts[4] === "alarms") return { kind: "alarms", installId };
  if (parts.length === 7 && parts[4] === "subscriptions") {
    const provider = decodeSegment(parts[5]);
    const subscriptionId = decodeSegment(parts[6]);
    if (!PROVIDERS.has(provider) || !validProviderId(subscriptionId)) return null;
    return { kind: "subscription", installId, provider, subscriptionId };
  }
  return null;
}

const ROUTE_METHODS = Object.freeze({
  collection: ["POST"],
  installation: ["PUT", "DELETE"],
  alarms: ["PUT"],
  subscription: ["PUT", "DELETE"],
});

function parseBearer(value) {
  return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value)?.[1] ?? null;
}

/**
 * Rate-limit key for the caller's network. Google's front end appends the address it saw to
 * X-Forwarded-For, so the last entry is the one a client cannot forge. IPv6 clients are grouped
 * by /64 because a single subscriber usually controls a whole /64.
 */
function clientNetworkKey(req) {
  const forwarded = getHeader(req, "x-forwarded-for").split(",").map((part) => part.trim()).filter(Boolean);
  let address = forwarded.at(-1) ?? req.ip ?? req.socket?.remoteAddress ?? "unknown";
  if (address.startsWith("::ffff:") && net.isIPv4(address.slice(7))) address = address.slice(7);
  if (net.isIPv6(address)) {
    const expanded = expandIpv6(address);
    return expanded ? `v6:${expanded.slice(0, 4).join(":")}` : `v6:${address}`;
  }
  return `v4:${address}`;
}

function expandIpv6(address) {
  const [head, tail = ""] = address.split("%")[0].split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = address.includes("::") ? (tail ? tail.split(":") : []) : [];
  if (headParts.some((part) => part.includes(".")) || tailParts.some((part) => part.includes("."))) return null;
  const fill = address.includes("::") ? 8 - headParts.length - tailParts.length : 0;
  const parts = [...headParts, ...Array(Math.max(fill, 0)).fill("0"), ...tailParts];
  return parts.length === 8 ? parts.map((part) => part.toLowerCase().padStart(4, "0")) : null;
}

function errorName(error) {
  return error?.code ?? error?.constructor?.name ?? "Error";
}

async function forEachLimited(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

/**
 * @param {object} options
 * @param {import("./ios-push-firestore").FirestorePushStore} options.store
 * @param {(token: string) => Promise<boolean>} options.verifyAppCheck resolves true for a valid token
 * @param {() => boolean} [options.enforceAppCheck] when false, registration accepts a missing token
 * @param {(request: object) => Promise<{status: number, reason?: string}>} options.sendPush
 */
function createIosPushService({
  store,
  verifyAppCheck,
  enforceAppCheck = () => true,
  sendPush,
  now = () => Date.now(),
  newClaimId = () => crypto.randomBytes(16).toString("hex"),
  newDispatchId = () => crypto.randomBytes(16).toString("hex"),
  logger = silentLogger,
}) {
  if (!store || typeof verifyAppCheck !== "function" || typeof sendPush !== "function") {
    throw new TypeError("store, verifyAppCheck, and sendPush are required");
  }

  /**
   * App Check is required for registration. Install-authenticated calls (which the NSE makes)
   * verify a token when one is sent but do not require it.
   */
  async function checkAppCheck(req, required) {
    const token = getHeader(req, "x-firebase-appcheck");
    if (!token) {
      if (required && enforceAppCheck()) throw new HttpError(401, "Firebase App Check token required");
      return;
    }
    let valid = false;
    try {
      valid = (await verifyAppCheck(token)) === true;
    } catch (_error) {
      valid = false;
    }
    if (!valid) throw new HttpError(401, "invalid Firebase App Check token");
  }

  async function authorize(req, installId, nowMs) {
    const secret = parseBearer(getHeader(req, "authorization"));
    if (!secret) throw new HttpError(401, "invalid install credentials");
    const result = await store.authorizeInstall(installId, sha256Hex(secret), INSTALL_RATE, nowMs);
    if (result === "unauthorized") throw new HttpError(401, "invalid install credentials");
    if (result === "rate-limited") throw new HttpError(429, "rate limit exceeded");
  }

  async function register(req, res, nowMs) {
    await checkAppCheck(req, true);
    if (!await store.consumeRateLimit(`registration:${clientNetworkKey(req)}`, REGISTRATION_RATE, nowMs)) {
      throw new HttpError(429, "registration rate limit exceeded");
    }
    const body = readJsonBody(req, MAX_API_BODY_BYTES);
    requireObject(body, ["installId", "installSecret", "apnsToken", "environment", "heartbeat"]);
    if (typeof body.installId !== "string" || !INSTALL_ID.test(body.installId) ||
        typeof body.installSecret !== "string" || !INSTALL_SECRET.test(body.installSecret)) {
      throw new HttpError(400, "installId (22 chars) and installSecret (43 chars) must be random base64url values");
    }
    const fields = validateRegistration(body);
    let outcome;
    try {
      outcome = await store.registerInstall(body.installId, { installSecretHash: sha256Hex(body.installSecret), ...fields }, nowMs);
    } catch (error) {
      if (error instanceof StoreError && error.code === "install-conflict") throw new HttpError(409, "install ID is already registered");
      throw error;
    }
    return jsonResponse(res, outcome === "created" ? 201 : 200, { installId: body.installId });
  }

  async function apiHandler(req, res) {
    const route = parseApiRoute(requestUrl(req).pathname);
    if (!route) return jsonResponse(res, 404, { error: "not found" });
    const verb = method(req);
    if (!ROUTE_METHODS[route.kind].includes(verb)) {
      setHeader(res, "allow", ROUTE_METHODS[route.kind].join(", "));
      return jsonResponse(res, 405, { error: "method not allowed" });
    }

    try {
      const nowMs = now();
      if (route.kind === "collection") return await register(req, res, nowMs);

      await authorize(req, route.installId, nowMs);
      await checkAppCheck(req, false);

      if (route.kind === "installation" && verb === "PUT") {
        const body = readJsonBody(req, MAX_API_BODY_BYTES);
        requireObject(body, ["apnsToken", "environment", "heartbeat"]);
        await store.updateRegistration(route.installId, validateRegistration(body), nowMs);
        return jsonResponse(res, 204);
      }
      if (route.kind === "installation") {
        await store.deleteInstall(route.installId);
        return jsonResponse(res, 204);
      }
      if (route.kind === "alarms") {
        const alarms = validateAlarms(readJsonBody(req, MAX_API_BODY_BYTES), nowMs);
        await store.replaceAlarms(route.installId, alarms, nowMs);
        return jsonResponse(res, 204);
      }

      const key = subscriptionDocumentId(route.provider, route.subscriptionId);
      if (verb === "PUT") {
        const subscription = validateSubscription(route.provider, readJsonBody(req, MAX_API_BODY_BYTES), nowMs);
        try {
          await store.upsertSubscription(key, { installId: route.installId, ...subscription }, nowMs);
        } catch (error) {
          if (error instanceof StoreError && error.code === "subscription-owner-conflict") {
            throw new HttpError(409, "subscription is registered to another install");
          }
          if (error instanceof StoreError && error.code === "subscription-limit") {
            throw new HttpError(409, `at most ${MAX_SUBSCRIPTIONS_PER_INSTALL} subscriptions per install`);
          }
          throw error;
        }
        return jsonResponse(res, 204);
      }
      try {
        await store.removeSubscription(key, route.installId);
      } catch (error) {
        // Do not reveal that another install owns this subscription.
        if (!(error instanceof StoreError && error.code === "subscription-owner-conflict")) throw error;
      }
      return jsonResponse(res, 204);
    } catch (error) {
      if (error instanceof HttpError) return jsonResponse(res, error.status, { error: error.message });
      logger.error("iOS push API request failed", { route: route.kind, error: errorName(error) });
      return jsonResponse(res, 500, { error: "server error" });
    }
  }

  /** Sends a claimed push and records the outcome. Never throws for APNs failures. */
  async function deliver(claim, at) {
    const { install, plan, claimId } = claim;
    const installId = install.installId;
    let result;
    try {
      result = await sendPush({ installId, install, kind: plan.kind, provider: plan.provider, at });
    } catch (error) {
      await store.failPush(installId, claimId, now());
      logger.warn("APNs request failed", { installId, kind: plan.kind, error: errorName(error) });
      return "failed";
    }
    if (result?.status === 200) {
      await store.completePush(installId, claimId, plan, at);
      return "sent";
    }
    if (result?.status === 410 || (result?.status === 400 && result?.reason === "BadDeviceToken")) {
      const reason = result.status === 410 ? "apns_unregistered" : "apns_bad_device_token";
      await store.disableInstall(installId, claimId, install.apnsToken, reason, now());
      logger.info("Disabled iOS install after APNs token rejection", { installId, status: result.status });
      return "disabled";
    }
    await store.failPush(installId, claimId, now());
    logger.warn("APNs rejected a push", { installId, kind: plan.kind, status: result?.status ?? null, reason: result?.reason ?? null });
    return "failed";
  }

  /** Records a provider change and pushes now, or leaves it pending for the scheduler. */
  async function relayChange(installId, provider) {
    const at = now();
    const claim = await store.recordChangeAndClaim(installId, provider, at, newClaimId());
    if (claim.status !== "claimed") return claim.status;
    return deliver(claim, at);
  }

  /** Plans and sends the next due push for one install. */
  async function processInstall(installId, renewalKeys = []) {
    const at = now();
    const claim = await store.planAndClaim(installId, renewalKeys, at, newClaimId());
    if (claim.status !== "claimed") return claim.status;
    return deliver(claim, at);
  }

  async function googleWebhookHandler(req, res) {
    if (method(req) !== "POST") {
      setHeader(res, "allow", "POST");
      return jsonResponse(res, 405, { error: "method not allowed" });
    }
    const channelId = getHeader(req, "x-goog-channel-id");
    if (!validProviderId(channelId)) return jsonResponse(res, 400, { error: "X-Goog-Channel-ID required" });
    try {
      const subscription = await store.getSubscription(subscriptionDocumentId("google", channelId));
      if (!subscription || subscription.provider !== "google" || subscription.expiresAtMs <= now()) {
        return jsonResponse(res, 204);
      }
      const token = getHeader(req, "x-goog-channel-token");
      if (!token || !safeEqualHex(sha256Hex(token), subscription.verificationHash)) {
        logger.warn("Google webhook channel token mismatch");
        return jsonResponse(res, 403, { error: "invalid channel token" });
      }
      if (!safeEqualHex(sha256Hex(getHeader(req, "x-goog-resource-id")), subscription.resourceIdHash)) {
        return jsonResponse(res, 204);
      }
      const state = getHeader(req, "x-goog-resource-state");
      if (state !== "exists" && state !== "not_exists") return jsonResponse(res, 204);
      await relayChange(subscription.installId, "google");
      return jsonResponse(res, 204);
    } catch (error) {
      logger.error("Google webhook processing failed", { error: errorName(error) });
      return jsonResponse(res, 500, { error: "server error" });
    }
  }

  async function microsoftWebhookHandler(req, res) {
    const verb = method(req);
    const validationToken = requestUrl(req).searchParams.get("validationToken");
    // Graph validates notification and lifecycle URLs with a POST (older docs: GET) carrying
    // ?validationToken=; it must be echoed as text/plain within 10 seconds.
    if (validationToken !== null && (verb === "POST" || verb === "GET")) {
      if (validationToken.length === 0 || validationToken.length > 2048) {
        return textResponse(res, 400, "invalid validationToken");
      }
      return textResponse(res, 200, validationToken);
    }
    if (verb !== "POST") {
      setHeader(res, "allow", "POST");
      return jsonResponse(res, 405, { error: "method not allowed" });
    }

    try {
      const body = readJsonBody(req, MAX_WEBHOOK_BODY_BYTES);
      if (!body || typeof body !== "object" || !Array.isArray(body.value) || body.value.length > MAX_GRAPH_NOTIFICATIONS) {
        throw new HttpError(400, "notification body must contain a value array");
      }
      const nowMs = now();
      const notifications = body.value.filter((notification) => notification && typeof notification === "object" &&
        validProviderId(notification.subscriptionId) && typeof notification.clientState === "string");
      const keys = [...new Set(notifications.map((notification) => subscriptionDocumentId("microsoft", notification.subscriptionId)))];
      if (keys.length > MAX_GRAPH_SUBSCRIPTIONS_PER_REQUEST) {
        throw new HttpError(400, `at most ${MAX_GRAPH_SUBSCRIPTIONS_PER_REQUEST} distinct subscriptions per request`);
      }
      const subscriptions = new Map();
      await forEachLimited(keys, WEBHOOK_CONCURRENCY, async (key) => {
        subscriptions.set(key, await store.getSubscription(key));
      });
      const changes = new Set();
      const renewals = new Map();
      let mismatches = 0;
      let late = 0;
      for (const notification of notifications) {
        const { subscriptionId, clientState } = notification;
        const lifecycleEvent = notification.lifecycleEvent ?? null;
        const key = subscriptionDocumentId("microsoft", subscriptionId);
        const subscription = subscriptions.get(key);
        if (!subscription || subscription.provider !== "microsoft") continue;
        // Past the recorded expiry, Graph can still deliver lifecycle events for a subscription
        // the device renewed without telling the relay (or that Graph removed). Routing them
        // lets the device repair it; change notifications for it stay ignored.
        const expired = subscription.expiresAtMs <= nowMs;
        if (expired && !GRAPH_LIFECYCLE_EVENTS.has(lifecycleEvent)) continue;
        if (!safeEqualHex(sha256Hex(clientState), subscription.verificationHash)) {
          mismatches += 1;
          continue;
        }
        if (expired) late += 1;
        if (lifecycleEvent === "reauthorizationRequired" || lifecycleEvent === "subscriptionRemoved") {
          if (!renewals.has(subscription.installId)) renewals.set(subscription.installId, new Set());
          renewals.get(subscription.installId).add(key);
        } else if (lifecycleEvent === null || lifecycleEvent === "missed") {
          changes.add(subscription.installId);
        }
      }

      if (mismatches > 0) logger.warn("Graph notifications with a mismatched clientState were ignored", { count: mismatches });
      if (late > 0) logger.info("Graph lifecycle events after the recorded expiry were routed", { count: late });
      // Graph wants an answer within about 3 seconds, so nothing here waits on APNs: the work is
      // recorded and a Firestore-triggered dispatch (or the scheduler) delivers the push.
      const installIds = [...new Set([...renewals.keys(), ...changes])];
      await forEachLimited(installIds, WEBHOOK_CONCURRENCY, async (installId) => {
        await store.recordWebhookNotifications(installId, {
          changeProvider: changes.has(installId) ? "microsoft" : null,
          renewalKeys: [...(renewals.get(installId) ?? [])],
        }, nowMs, newDispatchId());
      });
      return jsonResponse(res, 202);
    } catch (error) {
      if (error instanceof HttpError) return jsonResponse(res, error.status, { error: error.message });
      logger.error("Microsoft webhook processing failed", { error: errorName(error) });
      return jsonResponse(res, 500, { error: "server error" });
    }
  }

  /**
   * Delivers a dispatch queued by a webhook (Firestore trigger on `iosPushDispatches`). Plans
   * from the install's current state with the same claim, coalescing and collapse rules as the
   * scheduler, so duplicate or late dispatches send nothing extra. The document is deleted
   * afterwards; on failure the scheduler still finds the pending work. Never throws.
   */
  async function deliverDispatch(dispatchId, dispatch) {
    const installId = dispatch?.installId;
    const renewalKeys = Array.isArray(dispatch?.renewalKeys) ? dispatch.renewalKeys : [];
    let outcome = "invalid";
    try {
      if (typeof installId === "string" && INSTALL_ID.test(installId) &&
          renewalKeys.length <= MAX_GRAPH_SUBSCRIPTIONS_PER_REQUEST &&
          renewalKeys.every((key) => typeof key === "string" && SUBSCRIPTION_KEY.test(key))) {
        // Renewals recorded after the dispatch was queued (inside the dedupe window) go out too.
        const due = await store.listInstallRenewalsDue(installId, now());
        outcome = await processInstall(installId, [...new Set([...renewalKeys, ...due])]);
      } else {
        logger.warn("Ignoring a malformed iOS push dispatch");
      }
    } catch (error) {
      outcome = "error";
      logger.warn("iOS push dispatch failed; the scheduler will retry", { installId, error: errorName(error) });
    }
    if (typeof dispatchId === "string" && DISPATCH_ID.test(dispatchId)) {
      try {
        await store.deleteDispatch(dispatchId);
      } catch (error) {
        logger.warn("Could not delete an iOS push dispatch; it will be pruned", { error: errorName(error) });
      }
    }
    return outcome;
  }

  /**
   * One scheduler pass: prune expired records, then visit every install whose `nextWakeAtMs`
   * has passed or that has a renewal due. Stops starting new installs after `deadlineMs`.
   */
  async function scheduledPushes({ deadlineMs = Infinity } = {}) {
    const nowMs = now();
    try {
      await store.pruneExpiredRecords(nowMs);
    } catch (error) {
      logger.warn("Pruning expired iOS push records failed", { error: errorName(error) });
    }
    const [dueInstallIds, renewalsDue] = await Promise.all([
      store.listInstallIdsDue(nowMs, SCHEDULER_BATCH_LIMIT),
      store.listRenewalsDue(nowMs, SCHEDULER_BATCH_LIMIT),
    ]);
    const work = new Map(dueInstallIds.map((installId) => [installId, []]));
    for (const subscription of renewalsDue) {
      if (!work.has(subscription.installId)) work.set(subscription.installId, []);
      work.get(subscription.installId).push(subscription.key);
    }
    const counts = { installs: work.size, sent: 0, failed: 0, disabled: 0, idle: 0, errors: 0, skipped: 0 };
    await forEachLimited([...work.entries()], SCHEDULER_CONCURRENCY, async ([installId, renewalKeys]) => {
      if (now() >= deadlineMs) {
        counts.skipped += 1;
        return;
      }
      try {
        const outcome = await processInstall(installId, renewalKeys);
        counts[outcome] = (counts[outcome] ?? 0) + 1;
      } catch (error) {
        counts.errors += 1;
        logger.warn("Scheduled iOS push failed", { installId, error: errorName(error) });
      }
    });
    return counts;
  }

  return { apiHandler, googleWebhookHandler, microsoftWebhookHandler, deliverDispatch, scheduledPushes };
}

module.exports = {
  HttpError,
  INSTALL_RATE,
  MAX_ALARMS_PER_INSTALL,
  MAX_API_BODY_BYTES,
  MAX_WEBHOOK_BODY_BYTES,
  REGISTRATION_RATE,
  clientNetworkKey,
  createIosPushService,
  parseApiRoute,
  validateAlarms,
  validateHeartbeat,
  validateRegistration,
  validateSubscription,
};

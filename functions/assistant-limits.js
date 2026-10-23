"use strict";

// Abuse limits for the assistant connector.
//
// - LIMITS are fixed-window counters in Firestore, shared by every instance: per caller for the
//   browser steps (authorize, consent, approve), per connection's push messages, per iPhone's
//   device API calls, and valid DCR registrations per caller and overall.
// - INSTANCE_LIMITS are counted in memory per instance, with no database write. The functions run
//   at most 10 instances (maxInstances), so a cap holds at ten times its value overall, which is
//   enough to stop a flood without making every request pay for a shared counter.
//
// Overall caps count failed requests only (after cheap checks that cost nothing), so ordinary
// traffic never fills them, and a request that proves valid (a live token, a refresh token or code
// that exists) is never refused because of other callers' failures.

const net = require("node:net");

const { sha256Hex } = require("./assistant-records");
const { COLLECTIONS } = require("./assistant-data");

const MINUTE_MS = 60 * 1000;
const TEN_MINUTES_MS = 10 * MINUTE_MS;
const HOUR_MS = 60 * MINUTE_MS;

const LIMITS = {
  register: { limit: 30, windowMs: HOUR_MS },
  registerGlobal: { limit: 500, windowMs: HOUR_MS },
  authorize: { limit: 60, windowMs: TEN_MINUTES_MS },
  consent: { limit: 120, windowMs: TEN_MINUTES_MS },
  approve: { limit: 30, windowMs: TEN_MINUTES_MS },
  push: { limit: 40, windowMs: TEN_MINUTES_MS },
  // Per iPhone, for assistantDeviceApi: a push leads to one or two calls, and each connection may
  // send 40 pushes per window.
  device: { limit: 200, windowMs: TEN_MINUTES_MS },
};

const INSTANCE_LIMITS = {
  // Per connection (grant).
  toolCalls: { limit: 120, windowMs: TEN_MINUTES_MS },
  mcpMessages: { limit: 300, windowMs: TEN_MINUTES_MS },
  // Per presented grant at the token endpoint (client_id + grant type + code or refresh token hash).
  tokenGrant: { limit: 10, windowMs: TEN_MINUTES_MS },
  // Calls that did not come through Hosting: per network hop, and all of them together.
  hop: { limit: 300, windowMs: TEN_MINUTES_MS },
  directGlobal: { limit: 600, windowMs: TEN_MINUTES_MS },
  // Failed requests, per caller and overall (keyed by scope: Hosting traffic or direct calls).
  authorizeFailures: { limit: 30, windowMs: TEN_MINUTES_MS },
  authorizeFailuresGlobal: { limit: 300, windowMs: TEN_MINUTES_MS },
  consentFailures: { limit: 30, windowMs: TEN_MINUTES_MS },
  consentFailuresGlobal: { limit: 600, windowMs: TEN_MINUTES_MS },
  tokenFailures: { limit: 30, windowMs: TEN_MINUTES_MS },
  tokenFailuresGlobal: { limit: 600, windowMs: TEN_MINUTES_MS },
  registerFailures: { limit: 30, windowMs: TEN_MINUTES_MS },
  revoke: { limit: 120, windowMs: TEN_MINUTES_MS },
  metadataFetchHost: { limit: 20, windowMs: TEN_MINUTES_MS },
  metadataFetchGlobal: { limit: 100, windowMs: TEN_MINUTES_MS },
  unauthorized: { limit: 30, windowMs: MINUTE_MS },
  unauthorizedGlobal: { limit: 600, windowMs: MINUTE_MS },
};

/** Counts one use of `key` and returns false once the window's limit is exceeded. */
async function consume(db, key, { limit, windowMs }, now) {
  const windowStart = now - (now % windowMs);
  const ref = db.collection(COLLECTIONS.limits).doc(sha256Hex(`${key}|${windowStart}`));
  return db.runTransaction(async (transaction) => {
    const doc = await transaction.get(ref);
    const count = doc.exists ? doc.data().count ?? 0 : 0;
    if (count >= limit) return false;
    transaction.set(ref, { count: count + 1, expiresAt: new Date(windowStart + windowMs + HOUR_MS) });
    return true;
  });
}

/**
 * An in-memory fixed-window limiter: `limiter(key, now, weight = 1)` counts `weight` uses and
 * returns false once the limit is exceeded; `limiter.exceeded(key, now)` checks without counting;
 * `limiter.count(key, now)` is the window's count so far.
 */
function createMemoryLimiter({ limit, windowMs }) {
  const windows = new Map();
  const current = (key, now) => {
    const entry = windows.get(key);
    return entry && entry.windowStart === now - (now % windowMs) ? entry : null;
  };
  const limiter = (key, now, weight = 1) => {
    const entry = current(key, now);
    if (!entry) {
      if (windows.size > 10000) windows.clear();
      windows.set(key, { windowStart: now - (now % windowMs), count: weight });
      return weight <= limit;
    }
    entry.count += weight;
    return entry.count <= limit;
  };
  limiter.exceeded = (key, now) => (current(key, now)?.count ?? 0) >= limit;
  limiter.count = (key, now) => current(key, now)?.count ?? 0;
  limiter.limit = limit;
  return limiter;
}

// Hosts that serve a known assistant's Client ID Metadata Document (assistant-oauth-clients.js
// BRANDED_CLIENTS). Read lazily: that module loads this one.
function isBrandedHost(host) {
  const brands = require("./assistant-oauth-clients").BRANDED_CLIENTS;
  return Array.isArray(brands) && brands.some((brand) => brand.host === host);
}

/**
 * One in-memory limiter per INSTANCE_LIMITS entry, for a handler instance.
 *
 * Metadata document fetches for the branded assistant hosts are always allowed: their documents
 * are cached for a day and a failure for ten minutes per client_id, and authorize requests are
 * limited per caller and by failures, so junk client_ids on those hosts can't use up the fetch
 * budget the real Claude and ChatGPT documents need. getClient checks metadataFetchHost and then
 * metadataFetchGlobal in one expression, so the host check tells the overall check to let a
 * branded fetch through without counting it.
 */
function createInstanceLimiters() {
  const limiters = Object.fromEntries(Object.entries(INSTANCE_LIMITS).map(([name, window]) => [name, createMemoryLimiter(window)]));
  const hostLimiter = limiters.metadataFetchHost;
  const globalLimiter = limiters.metadataFetchGlobal;
  let brandedFetch = false;
  limiters.metadataFetchHost = Object.assign((host, now) => {
    brandedFetch = isBrandedHost(host);
    return brandedFetch || hostLimiter(host, now);
  }, { exceeded: hostLimiter.exceeded, count: hostLimiter.count, limit: hostLimiter.limit });
  limiters.metadataFetchGlobal = Object.assign((key, now) => {
    const branded = brandedFetch;
    brandedFetch = false;
    return branded || globalLimiter(key, now);
  }, { exceeded: globalLimiter.exceeded, count: globalLimiter.count, limit: globalLimiter.limit });
  return limiters;
}

// Google front-end ranges (not Google Cloud customer ranges) that Firebase Hosting reaches the
// functions from. Production requests through Hosting arrive from 66.249.80.0/20 and 74.125.0.0/16;
// the rest are Google's other front-end blocks, so a change on Google's side doesn't turn all
// Hosting traffic into "direct" calls.
const HOSTING_PROXY = new net.BlockList();
for (const [address, prefix] of [
  ["64.233.160.0", 19], ["66.102.0.0", 20], ["66.249.64.0", 19], ["72.14.192.0", 18], ["74.125.0.0", 16],
  ["108.177.0.0", 17], ["172.217.0.0", 16], ["173.194.0.0", 16], ["209.85.128.0", 17],
]) HOSTING_PROXY.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001:4860::", 32], ["2404:6800::", 32], ["2607:f8b0::", 32], ["2800:3f0::", 32], ["2a00:1450::", 32], ["2c0f:fb50::", 32],
]) HOSTING_PROXY.addSubnet(address, prefix, "ipv6");

function isHostingProxy(address) {
  const type = net.isIP(address);
  return type !== 0 && HOSTING_PROXY.check(address, type === 4 ? "ipv4" : "ipv6");
}

/** An IPv4 address, or an IPv6 address grouped by /64 (one subscriber usually holds a whole /64). */
function networkKey(address) {
  let value = address;
  if (value.startsWith("::ffff:") && net.isIPv4(value.slice(7))) value = value.slice(7);
  if (net.isIPv4(value)) return value;
  if (!net.isIPv6(value)) return null;
  const [head, tail = ""] = value.split("%")[0].split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = value.includes("::") ? (tail ? tail.split(":") : []) : [];
  const fill = value.includes("::") ? 8 - headParts.length - tailParts.length : 0;
  const parts = [...headParts, ...Array(Math.max(fill, 0)).fill("0"), ...tailParts];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-fA-F]{1,4}$/.test(part))) return value.toLowerCase();
  return `${parts.slice(0, 4).map((part) => part.toLowerCase().padStart(4, "0")).join(":")}::/64`;
}

const hostOfHeader = (value) => String(value ?? "").split(",")[0].trim().toLowerCase().replace(/:443$/, "");

/**
 * Who a request comes from, for per-caller limits.
 *
 * The functions are public (Hosting needs that) and are also reachable directly on their run.app
 * and cloudfunctions.net URLs, where a caller controls every header it sends; Cloud Run ingress
 * settings can't close those URLs because Hosting itself calls the run.app URL from outside
 * Google's internal network. Google's front end appends the address that connected to it to
 * X-Forwarded-For, so the last entry (the hop) is the one value a caller cannot choose.
 *
 * A request counts as coming through Hosting when the hop is a Google front-end address and
 * X-Forwarded-Host (set by Hosting) is one of this service's `hosts`. Then the visitor's address
 * from Fastly-Client-IP is the caller. Anything else is a direct call: its key is its own hop, it
 * never shares a key with a Hosting visitor, and direct calls have separate, smaller overall
 * budgets (`scope: "direct"`), so they can't use up the budgets of real assistant traffic.
 *
 * Returns {client, hop, direct, scope}.
 */
function clientKeys(req, { hosts = [] } = {}) {
  const header = (name) => {
    const value = req.headers?.[name];
    return Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : "";
  };
  const forwarded = header("x-forwarded-for").split(",").map((part) => part.trim()).filter(Boolean);
  const hop = String(forwarded.at(-1) || req.socket?.remoteAddress || "unknown").slice(0, 64);
  const viaHosting = isHostingProxy(hop) && hosts.includes(hostOfHeader(header("x-forwarded-host")));
  if (!viaHosting) return { client: `direct:${networkKey(hop) ?? hop}`, hop, direct: true, scope: "direct" };
  const visitor = networkKey(header("fastly-client-ip").split(",")[0].trim());
  // Without the visitor's address every Hosting request shares the front end's; still keyed apart
  // from direct calls.
  return { client: visitor ? `ip:${visitor}` : `proxy:${hop}`, hop, direct: false, scope: "all" };
}

/** Admits a direct call within its hop's and all direct calls' budgets; Hosting traffic always passes. */
function admitDirect(limiters, caller, now) {
  if (!caller.direct) return true;
  return limiters.hop(caller.hop, now) && limiters.directGlobal("direct", now);
}

/** True when the caller, or every caller in its scope together, used up a failure budget. */
function failuresExceeded(limiters, name, caller, now) {
  return limiters[`${name}Failures`].exceeded(caller.client, now) || limiters[`${name}FailuresGlobal`].exceeded(caller.scope, now);
}

/** Counts one failed request against the caller's and its scope's failure budgets. */
function countFailure(limiters, name, caller, now) {
  limiters[`${name}Failures`](caller.client, now);
  limiters[`${name}FailuresGlobal`]?.(caller.scope, now);
}

module.exports = {
  INSTANCE_LIMITS, LIMITS, admitDirect, clientKeys, consume, countFailure, createInstanceLimiters, createMemoryLimiter,
  failuresExceeded, isHostingProxy, networkKey,
};

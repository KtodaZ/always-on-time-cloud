"use strict";

// Abuse limits for the assistant connector.
//
// - LIMITS are fixed-window counters in Firestore, shared by every instance: per caller (see
//   clientKeys), per connection's push messages, and DCR registrations overall.
// - INSTANCE_LIMITS are counted in memory per instance, with no database write: per-connection
//   tool calls, per network hop, and global caps for the OAuth endpoints, metadata fetches and
//   unauthenticated MCP calls. The functions run at most 10 instances (maxInstances), so a cap
//   holds at ten times its value overall, which is enough to stop a flood without making every
//   request pay for a shared counter.

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
  token: { limit: 120, windowMs: TEN_MINUTES_MS },
  push: { limit: 40, windowMs: TEN_MINUTES_MS },
};

const INSTANCE_LIMITS = {
  toolCalls: { limit: 120, windowMs: TEN_MINUTES_MS },
  hop: { limit: 300, windowMs: TEN_MINUTES_MS },
  authorizeGlobal: { limit: 300, windowMs: TEN_MINUTES_MS },
  tokenGlobal: { limit: 600, windowMs: TEN_MINUTES_MS },
  consentGlobal: { limit: 600, windowMs: TEN_MINUTES_MS },
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
 * An in-memory fixed-window limiter: `limiter(key, now)` counts one use and returns false once
 * the limit is exceeded; `limiter.exceeded(key, now)` checks without counting.
 */
function createMemoryLimiter({ limit, windowMs }) {
  const windows = new Map();
  const current = (key, now) => {
    const entry = windows.get(key);
    return entry && entry.windowStart === now - (now % windowMs) ? entry : null;
  };
  const limiter = (key, now) => {
    const entry = current(key, now);
    if (!entry) {
      if (windows.size > 10000) windows.clear();
      windows.set(key, { windowStart: now - (now % windowMs), count: 1 });
      return limit >= 1;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
  limiter.exceeded = (key, now) => (current(key, now)?.count ?? 0) >= limit;
  return limiter;
}

/** One in-memory limiter per INSTANCE_LIMITS entry, for a handler instance. */
const createInstanceLimiters = () => Object.fromEntries(Object.entries(INSTANCE_LIMITS).map(([name, window]) => [name, createMemoryLimiter(window)]));

/**
 * Keys for per-caller limits.
 *
 * Both functions are reachable through Firebase Hosting (CDN, then Google's front end) and
 * directly on their run.app / cloudfunctions.net URLs, and a caller controls every request header
 * it sends. Google's front end appends the address that connected to it to X-Forwarded-For, so
 * the last entry is the one value a caller cannot choose:
 * - `hop`: that last entry. For a direct call it is the caller's own address; through Hosting it
 *   is the CDN's, shared by many users.
 * - `client`: Fastly-Client-IP (the visitor's address as Hosting's CDN reports it), else the hop.
 *   A direct caller can forge it, so it is only a best-effort per-person key: whatever it says,
 *   the caller stays inside its hop's limit and the global caps.
 * No header identifies a person both reliably and unforgeably here, so the global caps are what
 * bound abuse; per-caller limits keep one noisy client from using them up.
 */
function clientKeys(req) {
  const header = (name) => {
    const value = req.headers?.[name];
    return Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : "";
  };
  const forwarded = header("x-forwarded-for").split(",").map((part) => part.trim()).filter(Boolean);
  const hop = String(forwarded.at(-1) || req.socket?.remoteAddress || "unknown").slice(0, 64);
  const client = String(header("fastly-client-ip").split(",")[0].trim() || hop).slice(0, 64);
  return { client, hop };
}

module.exports = {
  INSTANCE_LIMITS, LIMITS, clientKeys, consume, createInstanceLimiters, createMemoryLimiter,
};

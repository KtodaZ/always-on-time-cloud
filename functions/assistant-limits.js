"use strict";

// Abuse limits for the assistant connector. Shared limits (per IP, per connection's push messages)
// are fixed-window counters in Firestore so they hold across instances; the per-connection tool
// call limit is kept in memory per instance, which with the function's instance cap is enough to
// stop a runaway client without a database write on every call.

const { sha256Hex } = require("./assistant-records");
const { COLLECTIONS } = require("./assistant-data");

const LIMITS = {
  register: { limit: 30, windowMs: 60 * 60 * 1000 },
  registerGlobal: { limit: 500, windowMs: 60 * 60 * 1000 },
  authorize: { limit: 60, windowMs: 10 * 60 * 1000 },
  consent: { limit: 120, windowMs: 10 * 60 * 1000 },
  approve: { limit: 30, windowMs: 10 * 60 * 1000 },
  push: { limit: 40, windowMs: 10 * 60 * 1000 },
  toolCalls: { limit: 120, windowMs: 10 * 60 * 1000 },
};

/** Counts one use of `key` and returns false once the window's limit is exceeded. */
async function consume(db, key, { limit, windowMs }, now) {
  const windowStart = now - (now % windowMs);
  const ref = db.collection(COLLECTIONS.limits).doc(sha256Hex(`${key}|${windowStart}`));
  return db.runTransaction(async (transaction) => {
    const doc = await transaction.get(ref);
    const count = doc.exists ? doc.data().count ?? 0 : 0;
    if (count >= limit) return false;
    transaction.set(ref, { count: count + 1, expiresAt: new Date(windowStart + windowMs + 60 * 60 * 1000) });
    return true;
  });
}

function createMemoryLimiter({ limit, windowMs }) {
  const windows = new Map();
  return (key, now) => {
    const windowStart = now - (now % windowMs);
    const entry = windows.get(key);
    if (!entry || entry.windowStart !== windowStart) {
      if (windows.size > 10000) windows.clear();
      windows.set(key, { windowStart, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

/**
 * The caller's IP for per-IP limits. Behind Firebase Hosting the CDN reports it in
 * Fastly-Client-IP; direct calls fall back to the first X-Forwarded-For entry. A caller can spoof
 * these headers only to spread its own requests across buckets, which the global limits still cap.
 */
function clientIp(req) {
  const header = (name) => {
    const value = req.headers?.[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const candidate = header("fastly-client-ip") || header("x-forwarded-for")?.split(",")[0] || req.ip || "unknown";
  return String(candidate).trim().slice(0, 64);
}

module.exports = { LIMITS, clientIp, consume, createMemoryLimiter };

"use strict";

// Pure scheduling rules for iOS relay pushes. No I/O: every function takes the current time.

const MINUTE_MS = 60 * 1000;
const COALESCE_MS = 2 * MINUTE_MS;
const CLAIM_STALE_MS = 2 * MINUTE_MS;
const PRECHECK_STAGES = Object.freeze([
  Object.freeze({ stage: "t20", leadMs: 20 * MINUTE_MS }),
  Object.freeze({ stage: "t8", leadMs: 8 * MINUTE_MS }),
]);
// A stage is due from T-lead until T-lead+window. The scheduler runs every minute, so a two
// minute window tolerates one late or skipped run.
const PRECHECK_WINDOW_MS = 2 * MINUTE_MS;
const RENEW_LEAD_MS = 24 * 60 * MINUTE_MS;
const RENEW_RETRY_MS = 6 * 60 * MINUTE_MS;
const FAILURE_BACKOFF_MAX_MS = 30 * MINUTE_MS;
// Higher-urgency kinds first. Only one push is sent per install per coalescing window.
const KIND_ORDER = Object.freeze(["precheck", "change", "renew", "heartbeat"]);

const formatterCache = new Map();

function localFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone.length === 0 || timeZone.length > 100) return false;
  try {
    localFormatter(timeZone);
    return true;
  } catch (_error) {
    return false;
  }
}

function localMinuteOfDay(nowMs, timeZone) {
  const parts = localFormatter(timeZone).formatToParts(new Date(nowMs));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return hour * 60 + minute;
}

function clockMinute(value) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

/** Active hours include `start` and exclude `end`; a range may cross midnight. */
function isWithinActiveHours(nowMs, heartbeat) {
  const minute = localMinuteOfDay(nowMs, heartbeat.timeZone);
  const start = clockMinute(heartbeat.activeHours.start);
  const end = clockMinute(heartbeat.activeHours.end);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** Earliest time >= fromMs that falls inside active hours (minute resolution, DST tolerant). */
function nextActiveTime(fromMs, heartbeat) {
  if (isWithinActiveHours(fromMs, heartbeat)) return fromMs;
  const start = clockMinute(heartbeat.activeHours.start);
  const minute = localMinuteOfDay(fromMs, heartbeat.timeZone);
  let candidate = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS + ((start - minute + 1440) % 1440) * MINUTE_MS;
  if (candidate < fromMs) candidate += MINUTE_MS;
  // The jump above uses the UTC offset at `fromMs`, so a DST transition (or a start time inside
  // a skipped hour) can land up to an hour off either way: walk forward until active, then back
  // to the first active minute.
  for (let step = 0; step < 12 && !isWithinActiveHours(candidate, heartbeat); step += 1) {
    candidate += 15 * MINUTE_MS;
  }
  for (let step = 0; step < 90 && candidate - MINUTE_MS >= fromMs &&
      isWithinActiveHours(candidate - MINUTE_MS, heartbeat); step += 1) {
    candidate -= MINUTE_MS;
  }
  return candidate;
}

function heartbeatBaseMs(install) {
  return Math.max(
    Number.isSafeInteger(install.lastPushAtMs) ? install.lastPushAtMs : 0,
    Number.isSafeInteger(install.createdAtMs) ? install.createdAtMs : 0,
  );
}

/** Heartbeats are skipped while any accepted push is more recent than the interval. */
function isHeartbeatDue(install, nowMs) {
  const heartbeat = install.heartbeat;
  if (!heartbeat) return false;
  return nowMs - heartbeatBaseMs(install) >= heartbeat.intervalMinutes * MINUTE_MS &&
    isWithinActiveHours(nowMs, heartbeat);
}

function stageWindow(triggerAtMs, leadMs) {
  const startMs = triggerAtMs - leadMs;
  return { startMs, endMs: startMs + PRECHECK_WINDOW_MS };
}

/**
 * Precheck stages that are due now and not yet sent for this trigger. With `lookaheadMs`, also
 * stages whose window opens within that time: a push that just went out covers them, since no
 * other push may follow inside the coalescing window anyway.
 */
function duePrecheckStages(alarms, nowMs, { lookaheadMs = 0 } = {}) {
  const due = [];
  for (const alarm of alarms ?? []) {
    if (!Number.isSafeInteger(alarm?.triggerAtMs) || alarm.triggerAtMs <= nowMs) continue;
    for (const { stage, leadMs } of PRECHECK_STAGES) {
      if (alarm.sent?.[stage]) continue;
      const { startMs, endMs } = stageWindow(alarm.triggerAtMs, leadMs);
      if (nowMs + lookaheadMs >= startMs && nowMs <= endMs) due.push({ key: alarm.key, stage });
    }
  }
  return due;
}

function pushBlockedUntil(install) {
  let blockedUntil = 0;
  if (Number.isSafeInteger(install.lastPushAtMs)) blockedUntil = install.lastPushAtMs + COALESCE_MS;
  if (Number.isSafeInteger(install.pushClaimedAtMs)) {
    blockedUntil = Math.max(blockedUntil, install.pushClaimedAtMs + CLAIM_STALE_MS);
  }
  if (Number.isSafeInteger(install.retryAfterMs)) blockedUntil = Math.max(blockedUntil, install.retryAfterMs);
  return blockedUntil;
}

/** True when a new push may be sent now (coalescing, in-flight claim, failure backoff). */
function canSendNow(install, nowMs) {
  return Boolean(install) && install.enabled === true && nowMs >= pushBlockedUntil(install);
}

/**
 * When the scheduler next needs to look at this install. Renewals are tracked on subscription
 * documents and queried separately, so they are not part of this value. Returns null when the
 * install is disabled.
 */
function computeNextWakeAtMs(install, nowMs) {
  if (!install || install.enabled !== true) return null;
  const candidates = [];
  if (install.heartbeat) {
    const dueAt = Math.max(heartbeatBaseMs(install) + install.heartbeat.intervalMinutes * MINUTE_MS, nowMs);
    candidates.push(nextActiveTime(dueAt, install.heartbeat));
  }
  if (Number.isSafeInteger(install.pendingChangeAtMs)) candidates.push(nowMs);
  for (const alarm of install.alarms ?? []) {
    if (!Number.isSafeInteger(alarm?.triggerAtMs) || alarm.triggerAtMs <= nowMs) continue;
    for (const { stage, leadMs } of PRECHECK_STAGES) {
      if (alarm.sent?.[stage]) continue;
      const { startMs, endMs } = stageWindow(alarm.triggerAtMs, leadMs);
      if (endMs >= nowMs) candidates.push(Math.max(startMs, nowMs));
    }
  }
  if (candidates.length === 0) return null;
  return Math.max(Math.min(...candidates), pushBlockedUntil(install));
}

/**
 * When the scheduler next needs to look at this install for an alarm about to ring or a calendar
 * change (not heartbeats), or null. The scheduler visits these installs first, so a flood of
 * installs that only want heartbeats can't delay the pushes that keep alarms right.
 */
function computePriorityWakeAtMs(install, nowMs) {
  if (!install || install.enabled !== true) return null;
  const candidates = [];
  if (Number.isSafeInteger(install.pendingChangeAtMs)) candidates.push(nowMs);
  for (const alarm of install.alarms ?? []) {
    if (!Number.isSafeInteger(alarm?.triggerAtMs) || alarm.triggerAtMs <= nowMs) continue;
    for (const { stage, leadMs } of PRECHECK_STAGES) {
      if (alarm.sent?.[stage]) continue;
      const { startMs, endMs } = stageWindow(alarm.triggerAtMs, leadMs);
      if (endMs >= nowMs) candidates.push(Math.max(startMs, nowMs));
    }
  }
  if (candidates.length === 0) return null;
  return Math.max(Math.min(...candidates), pushBlockedUntil(install));
}

/** Both scheduler fields for an install document. */
function wakeFields(install, nowMs) {
  return { nextWakeAtMs: computeNextWakeAtMs(install, nowMs), priorityWakeAtMs: computePriorityWakeAtMs(install, nowMs) };
}

/**
 * Chooses the single push to send for an install now, or null. `renewals` are subscription
 * records whose renewal prompt is due. A precheck stage opening within the coalescing window
 * upgrades a due heartbeat to a priority-10 precheck, because no separate push could follow.
 */
function planPush(install, nowMs, { renewals = [] } = {}) {
  if (!canSendNow(install, nowMs)) return null;
  const stages = duePrecheckStages(install.alarms, nowMs);
  const upcomingStages = duePrecheckStages(install.alarms, nowMs, { lookaheadMs: COALESCE_MS });
  const dueRenewals = renewals.filter((subscription) => isRenewalDue(subscription, nowMs));
  const candidates = {
    precheck: stages.length > 0,
    change: Number.isSafeInteger(install.pendingChangeAtMs),
    renew: dueRenewals.length > 0,
    heartbeat: isHeartbeatDue(install, nowMs),
  };
  let kind = KIND_ORDER.find((candidate) => candidates[candidate]);
  if (!kind) return null;
  if (kind === "heartbeat" && upcomingStages.length > 0) kind = "precheck";
  let provider;
  if (kind === "change") provider = install.pendingChangeProvider ?? undefined;
  if (kind === "renew") {
    const providers = new Set(dueRenewals.map((subscription) => subscription.provider));
    if (providers.size === 1) provider = [...providers][0];
  }
  return {
    kind,
    ...(provider ? { provider } : {}),
    renewalKeys: kind === "renew" ? dueRenewals.map((subscription) => subscription.key) : [],
  };
}

function initialRenewDueAtMs(expiresAtMs) {
  return expiresAtMs - RENEW_LEAD_MS;
}

/** After an accepted renew prompt, ask again later unless the subscription expires first. */
function renewRetryAtMs(nowMs, expiresAtMs) {
  const retryAt = nowMs + RENEW_RETRY_MS;
  return retryAt < expiresAtMs ? retryAt : null;
}

/**
 * A renewal is due from `renewDueAtMs` while the subscription is live. Past its recorded expiry
 * only an explicit request (a Graph lifecycle event) is due: Graph still knows the subscription
 * (the device renewed it but the new expiration never reached the relay, or Graph removed it),
 * so one renew prompt lets the device renew or recreate it.
 */
function isRenewalDue(subscription, nowMs) {
  if (!subscription || !Number.isSafeInteger(subscription.renewDueAtMs) || subscription.renewDueAtMs > nowMs) return false;
  if (Number.isSafeInteger(subscription.expiresAtMs) && subscription.expiresAtMs > nowMs) return true;
  return Number.isSafeInteger(subscription.renewalRequestedAtMs);
}

function failureBackoffMs(failureCount) {
  const exponent = Math.max(0, Math.min(failureCount - 1, 5));
  return Math.min(MINUTE_MS * 2 ** exponent, FAILURE_BACKOFF_MAX_MS);
}

module.exports = {
  CLAIM_STALE_MS,
  COALESCE_MS,
  KIND_ORDER,
  PRECHECK_STAGES,
  PRECHECK_WINDOW_MS,
  RENEW_LEAD_MS,
  RENEW_RETRY_MS,
  canSendNow,
  computeNextWakeAtMs,
  computePriorityWakeAtMs,
  duePrecheckStages,
  failureBackoffMs,
  initialRenewDueAtMs,
  isHeartbeatDue,
  isRenewalDue,
  isValidTimeZone,
  isWithinActiveHours,
  nextActiveTime,
  planPush,
  renewRetryAtMs,
  wakeFields,
};

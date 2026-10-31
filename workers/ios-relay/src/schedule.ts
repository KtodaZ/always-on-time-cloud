// Pure scheduling rules for relay pushes (docs/IOS_PUSH_PROTOCOL.md section 6). No I/O: every
// function takes the current time.

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** At most one push per install per 2 minutes, counted from the last push APNs accepted. */
export const COALESCE_MS = 2 * MINUTE_MS;
/** An in-flight claim expires after this, in case the sender died. */
export const CLAIM_STALE_MS = 2 * MINUTE_MS;
/** Polling installs: the meeting window before each alarm trigger. */
export const MEETING_WINDOW_MS = 30 * MINUTE_MS;
/** Polling installs: minimum gap between freshness points inside a meeting window. */
export const MEETING_WINDOW_GAP_MS = 5 * MINUTE_MS;
/** Polling installs: heartbeat interval inside active hours. */
export const HEARTBEAT_INTERVAL_MS = 60 * MINUTE_MS;
/** Non-polling installs: precheck stages before each alarm trigger. */
export const PRECHECK_STAGES = Object.freeze([
  Object.freeze({ stage: "t20" as const, leadMs: 20 * MINUTE_MS }),
  Object.freeze({ stage: "t8" as const, leadMs: 8 * MINUTE_MS }),
]);
/** A stage is due from its start for this long. */
export const PRECHECK_WINDOW_MS = 2 * MINUTE_MS;
export const RENEW_LEAD_MS = DAY_MS;
export const RENEW_RETRY_MS = 6 * HOUR_MS;
export const FAILURE_BACKOFF_MAX_MS = 30 * MINUTE_MS;
/**
 * Ring end (IOS-BUG-55): an AlarmKit alarm nobody answers keeps alerting until app code stops it,
 * so the relay wakes the phone this long after each armed trigger's ring time has run out. The
 * margin covers clock skew and APNs latency: the phone acts only once the ring time has passed.
 */
export const RING_END_MARGIN_MS = 20 * 1000;
/** A ring end not sent within this long after it was due is dropped (the phone also checks on every wake). */
export const RING_END_WINDOW_MS = HOUR_MS;
/** Longest ring time the relay accepts, as Android's `alarm_duration_seconds` (0 = until dismissed). */
export const MAX_RING_SECONDS = 86400;
/**
 * Higher-urgency kinds first. Only one push is sent per install per coalescing window, except a
 * ring end, which only waits for an in-flight push or a failure backoff.
 */
export const KIND_ORDER = Object.freeze(["ringEnd", "precheck", "change", "renew", "heartbeat"] as const);

export type PushKind = (typeof KIND_ORDER)[number];
export type Provider = "google" | "microsoft";
export type Stage = (typeof PRECHECK_STAGES)[number]["stage"];

export interface ActiveHours {
  start: string;
  end: string;
}

export interface Freshness {
  polling: boolean;
  activeHours: ActiveHours;
  timeZone: string;
  /** How long the phone's alarms ring before it stops them (0 = until dismissed); absent: no ring-end wakes. */
  ringSeconds?: number;
}

export interface AlarmState {
  key: string;
  triggerAt: number;
  sentT20: number | null;
  sentT8: number | null;
  /** False for a trigger the phone reported as not armed in AlarmKit; absent or true: armed. */
  armed?: boolean;
  /** When a push sent after this trigger's ring ended (any kind) was accepted; null until then. */
  ringEndSentAt?: number | null;
}

export interface DeliveryState {
  version: 1;
  generation: number;
  snapshotRevision: number;
  nextRefreshAt: number | null;
  lastWakeAt: number | null;
  eligible: boolean;
  outstanding: { id: string; generation: number; issuedAt: number; startedAt: number; attempts: number; nextAt: number | null } | null;
}

export interface InstallState {
  receipt?: DeliveryState;
  enabled: boolean;
  freshness: Freshness;
  createdAt: number;
  /** Last push APNs accepted (coalescing). */
  lastPushAt: number | null;
  /** Last full device sync the device reported through `/synced` (not from a relay push). */
  lastSyncAt: number | null;
  pendingChangeAt: number | null;
  pendingChangeProvider: Provider | null;
  claimedAt: number | null;
  retryAfter: number | null;
  alarms: AlarmState[];
}

export interface SubscriptionState {
  key: string;
  provider: Provider;
  expiresAt: number;
  renewDueAt: number | null;
  renewalRequestedAt: number | null;
}

export interface PushPlan {
  kind: PushKind;
  provider?: Provider;
  renewalKeys: string[];
  /**
   * Receipt installs: retry this delivery at RETRY_OFFSETS_MINUTES until a receipt arrives. True
   * when it carries a change or a horizon deadline; meeting-window checks repeat on their own.
   */
  burst?: boolean;
}

// Keyed by canonical zone names only (validation stores the canonical name), so the cache is bounded
// by the IANA zone list however callers spell a zone.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function newFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function localFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = newFormatter(timeZone);
  const canonical = formatter.resolvedOptions().timeZone;
  if (canonical === timeZone) formatterCache.set(canonical, formatter);
  return formatter;
}

/** The canonical IANA name for a zone (e.g. "america/new_york" -> "America/New_York"), or null. */
export function canonicalTimeZone(timeZone: unknown): string | null {
  if (typeof timeZone !== "string" || timeZone.length === 0 || timeZone.length > 100) return null;
  try {
    return newFormatter(timeZone).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function localMinuteOfDay(nowMs: number, timeZone: string): number {
  const parts = localFormatter(timeZone).formatToParts(new Date(nowMs));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return hour * 60 + minute;
}

function clockMinute(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

/** Active hours include `start` and exclude `end`; a range may cross midnight. */
export function isWithinActiveHours(nowMs: number, freshness: Freshness): boolean {
  const minute = localMinuteOfDay(nowMs, freshness.timeZone);
  const start = clockMinute(freshness.activeHours.start);
  const end = clockMinute(freshness.activeHours.end);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** Earliest time >= fromMs inside active hours (minute resolution, DST tolerant). */
export function nextActiveTime(fromMs: number, freshness: Freshness): number {
  if (isWithinActiveHours(fromMs, freshness)) return fromMs;
  const start = clockMinute(freshness.activeHours.start);
  const minute = localMinuteOfDay(fromMs, freshness.timeZone);
  let candidate = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS + ((start - minute + 1440) % 1440) * MINUTE_MS;
  if (candidate < fromMs) candidate += MINUTE_MS;
  // The jump uses the UTC offset at `fromMs`, so a DST change can land up to an hour off either
  // way: walk forward until active, then back to the first active minute.
  for (let step = 0; step < 12 && !isWithinActiveHours(candidate, freshness); step += 1) candidate += 15 * MINUTE_MS;
  for (let step = 0; step < 90 && candidate - MINUTE_MS >= fromMs && isWithinActiveHours(candidate - MINUTE_MS, freshness); step += 1) {
    candidate -= MINUTE_MS;
  }
  return candidate;
}

/**
 * The install's freshness point: the newest accepted push or reported device sync. Heartbeats and
 * meeting-window prechecks count from here.
 */
export function freshAt(install: InstallState): number | null {
  const values = [install.receipt ? null : install.lastPushAt, install.lastSyncAt].filter((value): value is number => Number.isSafeInteger(value));
  return values.length > 0 ? Math.max(...values) : null;
}

function heartbeatBase(install: InstallState): number {
  return Math.max(freshAt(install) ?? 0, install.createdAt);
}

/** Polling installs only: an hour since the last freshness point, inside active hours. */
export function isHeartbeatDue(install: InstallState, nowMs: number): boolean {
  if (!install.freshness.polling) return false;
  return nowMs - heartbeatBase(install) >= HEARTBEAT_INTERVAL_MS && isWithinActiveHours(nowMs, install.freshness);
}

function liveAlarms(install: InstallState, nowMs: number): AlarmState[] {
  return install.alarms.filter((alarm) => Number.isSafeInteger(alarm.triggerAt) && alarm.triggerAt > nowMs);
}

/**
 * Polling installs: true when `nowMs` is inside some alarm's meeting window [T-30 min, T) and at
 * least 5 minutes have passed since the freshness point. With `lookaheadMs`, also when a window
 * opens within that time (used to upgrade a heartbeat, which no other push could follow).
 */
export function isMeetingWindowDue(install: InstallState, nowMs: number, { lookaheadMs = 0 } = {}): boolean {
  if (!install.freshness.polling) return false;
  const fresh = freshAt(install);
  if (fresh !== null && nowMs - fresh < MEETING_WINDOW_GAP_MS) return false;
  return liveAlarms(install, nowMs).some((alarm) => nowMs + lookaheadMs >= alarm.triggerAt - MEETING_WINDOW_MS);
}

function stageWindow(triggerAt: number, leadMs: number): { startMs: number; endMs: number } {
  const startMs = triggerAt - leadMs;
  return { startMs, endMs: startMs + PRECHECK_WINDOW_MS };
}

function stageSent(alarm: AlarmState, stage: Stage): boolean {
  return (stage === "t20" ? alarm.sentT20 : alarm.sentT8) !== null;
}

/**
 * Non-polling installs: precheck stages due now and not yet sent. With `lookaheadMs`, also stages
 * whose window opens within that time: a push that just went out covers them, since no other push
 * may follow inside the coalescing window.
 */
export function dueStages(install: InstallState, nowMs: number, { lookaheadMs = 0 } = {}): Array<{ key: string; stage: Stage }> {
  if (install.freshness.polling) return [];
  const due: Array<{ key: string; stage: Stage }> = [];
  for (const alarm of liveAlarms(install, nowMs)) {
    for (const { stage, leadMs } of PRECHECK_STAGES) {
      if (stageSent(alarm, stage)) continue;
      const { startMs, endMs } = stageWindow(alarm.triggerAt, leadMs);
      if (nowMs + lookaheadMs >= startMs && nowMs < alarm.triggerAt) due.push({ key: alarm.key, stage });
    }
  }
  return due;
}

/** Non-polling stages a reported device sync at `syncedAt` satisfies: started at or before it. */
export function stagesSatisfiedBySync(install: InstallState, syncedAt: number): Array<{ key: string; stage: Stage }> {
  if (install.freshness.polling) return [];
  const satisfied: Array<{ key: string; stage: Stage }> = [];
  for (const alarm of liveAlarms(install, syncedAt)) {
    for (const { stage, leadMs } of PRECHECK_STAGES) {
      if (!stageSent(alarm, stage) && alarm.triggerAt - leadMs <= syncedAt) satisfied.push({ key: alarm.key, stage });
    }
  }
  return satisfied;
}

/** Stages an accepted push sent at `sentAt` satisfies (priority-10 pushes look ahead). */
export function stagesSatisfiedByPush(install: InstallState, kind: PushKind, sentAt: number): Array<{ key: string; stage: Stage }> {
  return dueStages(install, sentAt, { lookaheadMs: kind === "heartbeat" ? 0 : COALESCE_MS });
}

export function pushBlockedUntil(install: InstallState): number {
  let blockedUntil = 0;
  if (install.lastPushAt !== null) blockedUntil = install.lastPushAt + COALESCE_MS;
  if (install.claimedAt !== null) blockedUntil = Math.max(blockedUntil, install.claimedAt + CLAIM_STALE_MS);
  if (install.retryAfter !== null) blockedUntil = Math.max(blockedUntil, install.retryAfter);
  return blockedUntil;
}

/** True when a new push may be sent now (enabled, coalescing, in-flight claim, failure backoff). */
export function canSendNow(install: InstallState, nowMs: number): boolean {
  return install.enabled && nowMs >= pushBlockedUntil(install);
}

/**
 * A renewal is due from `renewDueAt` while the subscription is live. Past its recorded expiry only
 * an explicit request (a Graph lifecycle event) is due.
 */
export function isRenewalDue(subscription: SubscriptionState, nowMs: number): boolean {
  if (subscription.renewDueAt === null || subscription.renewDueAt > nowMs) return false;
  if (subscription.expiresAt > nowMs) return true;
  return subscription.renewalRequestedAt !== null;
}

/** A subscription whose renewal can never become due again (expired, nothing requested). */
export function isRenewalDead(subscription: SubscriptionState, nowMs: number): boolean {
  return subscription.renewDueAt !== null && subscription.renewDueAt <= nowMs && !isRenewalDue(subscription, nowMs);
}

export function initialRenewDueAt(expiresAt: number): number {
  return expiresAt - RENEW_LEAD_MS;
}

/** After an accepted renew prompt, ask again later unless the subscription expires first. */
export function renewRetryAt(nowMs: number, expiresAt: number): number | null {
  const retryAt = nowMs + RENEW_RETRY_MS;
  return retryAt < expiresAt ? retryAt : null;
}

export function failureBackoffMs(failureCount: number): number {
  const exponent = Math.max(0, Math.min(failureCount - 1, 5));
  return Math.min(MINUTE_MS * 2 ** exponent, FAILURE_BACKOFF_MAX_MS);
}

// --- Ring ends (IOS-BUG-55) -------------------------------------------------------------------

/** When the phone's ring for `alarm` has run out (trigger + ring time), or null when none is due. */
export function ringEndsAt(install: InstallState, alarm: AlarmState): number | null {
  const seconds = install.freshness.ringSeconds;
  if (!seconds || seconds <= 0 || alarm.armed === false || !Number.isSafeInteger(alarm.triggerAt)) return null;
  return alarm.triggerAt + seconds * 1000;
}

/** When the ring-end wake for `alarm` goes out (ring end + margin), or null. */
export function ringEndWakeAt(install: InstallState, alarm: AlarmState): number | null {
  const ends = ringEndsAt(install, alarm);
  return ends === null ? null : ends + RING_END_MARGIN_MS;
}

function openRingEnds(install: InstallState, nowMs: number): Array<{ alarm: AlarmState; wakeAt: number }> {
  const open: Array<{ alarm: AlarmState; wakeAt: number }> = [];
  for (const alarm of install.alarms) {
    if (alarm.ringEndSentAt !== null && alarm.ringEndSentAt !== undefined) continue;
    const wakeAt = ringEndWakeAt(install, alarm);
    if (wakeAt !== null && nowMs < wakeAt + RING_END_WINDOW_MS) open.push({ alarm, wakeAt });
  }
  return open;
}

/** Ring ends whose wake is due now and not yet covered by a push. */
export function dueRingEnds(install: InstallState, nowMs: number): AlarmState[] {
  return openRingEnds(install, nowMs).filter(({ wakeAt }) => wakeAt <= nowMs).map(({ alarm }) => alarm);
}

/**
 * Ring ends an accepted push sent at `sentAt` covers, whatever its kind: every wake makes the phone
 * stop alarms whose ring time has run out, so any push after the ring ended does the job.
 */
export function ringEndsCoveredByPush(install: InstallState, sentAt: number): string[] {
  // Only a push the ring-end wake itself would not precede: one sooner after the ring end may
  // reach an iPhone whose clock runs behind before its ring time is up there.
  return openRingEnds(install, sentAt)
    .filter(({ alarm }) => (ringEndsAt(install, alarm) ?? Infinity) + RING_END_MARGIN_MS <= sentAt)
    .map(({ alarm }) => alarm.key);
}

/** A ring end waits for an in-flight push and a failure backoff, not for the 2-minute coalescing. */
function ringEndBlockedUntil(install: InstallState): number {
  let blockedUntil = 0;
  if (install.claimedAt !== null) blockedUntil = install.claimedAt + CLAIM_STALE_MS;
  if (install.retryAfter !== null) blockedUntil = Math.max(blockedUntil, install.retryAfter);
  return blockedUntil;
}

/** When the next ring-end wake may go out, or null. */
function nextRingEndAt(install: InstallState, nowMs: number): number | null {
  const open = openRingEnds(install, nowMs);
  if (open.length === 0) return null;
  return Math.max(Math.min(...open.map(({ wakeAt }) => wakeAt)), ringEndBlockedUntil(install), nowMs);
}

/** Earliest time a precheck could become due (meeting window or stage), or null. */
function nextPrecheckAt(install: InstallState, nowMs: number): number | null {
  const candidates: number[] = [];
  if (install.freshness.polling) {
    const fresh = freshAt(install);
    const earliest = Math.max(nowMs, fresh === null ? nowMs : fresh + MEETING_WINDOW_GAP_MS);
    for (const alarm of liveAlarms(install, nowMs)) {
      const start = Math.max(alarm.triggerAt - MEETING_WINDOW_MS, earliest);
      if (start < alarm.triggerAt) candidates.push(start);
    }
  } else {
    for (const alarm of liveAlarms(install, nowMs)) {
      for (const { stage, leadMs } of PRECHECK_STAGES) {
        if (stageSent(alarm, stage)) continue;
        const { startMs, endMs } = stageWindow(alarm.triggerAt, leadMs);
        if (alarm.triggerAt > nowMs) candidates.push(Math.max(startMs, nowMs));
      }
    }
  }
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

/** Receipt installs: minimum gap between wakes inside a polling meeting window or an unverified stage. */
export const RECEIPT_WINDOW_GAP_MS = 4 * MINUTE_MS;
/** Receipt installs: an unacknowledged delivery is retried this many minutes after its first send. */
export const RETRY_OFFSETS_MINUTES = Object.freeze([0, 2, 4, 8, 16]);

/**
 * Receipt installs: the earliest time a meeting-window check is due, or null. Freshness counts only
 * from verified receipts (`lastSyncAt`); `lastWakeAt` spaces repeated attempts so an unacknowledged
 * install is not pushed every two minutes.
 *  - polling (some calendar has no working change feed): every 4 minutes in [T-30 min, T);
 *  - signed-in only: the T-20 and T-8 stages, each due from its start until a verified receipt at or
 *    after that start, or until the trigger passes (backoff can delay a stage but never skip it).
 */
function receiptPrecheckAt(install: InstallState, nowMs: number): number | null {
  const verified = install.lastSyncAt;
  const lastWake = install.receipt?.lastWakeAt ?? null;
  const candidates: number[] = [];
  for (const alarm of liveAlarms(install, nowMs)) {
    if (install.freshness.polling) {
      const at = Math.max(alarm.triggerAt - MEETING_WINDOW_MS, Math.max(verified ?? 0, lastWake ?? 0) + RECEIPT_WINDOW_GAP_MS, nowMs);
      if (at < alarm.triggerAt) candidates.push(at);
      continue;
    }
    for (const { leadMs } of PRECHECK_STAGES) {
      const start = alarm.triggerAt - leadMs;
      if (verified !== null && verified >= start) continue;
      const spaced = lastWake !== null && lastWake >= start ? lastWake + RECEIPT_WINDOW_GAP_MS : 0;
      const at = Math.max(start, spaced, nowMs);
      if (at < alarm.triggerAt) candidates.push(at);
    }
  }
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

/**
 * Receipt installs: the horizon wake. The published `nextRefreshAt`, bounded by one day after the
 * last wake or verified sync, so a quiet install is still woken daily when nothing else woke it.
 * Once a wake was sent for a deadline, the deadline is spent: retries are the delivery burst's job.
 */
function receiptRecoveryAt(install: InstallState, nowMs: number): number {
  const r = install.receipt!;
  const lastWake = Math.max(install.createdAt, install.lastSyncAt ?? 0, r.lastWakeAt ?? 0);
  const explicit = r.nextRefreshAt === null || (r.lastWakeAt !== null && r.lastWakeAt >= r.nextRefreshAt) ? Infinity : r.nextRefreshAt;
  return Math.max(nowMs, Math.min(explicit, lastWake + DAY_MS));
}

/** Receipt installs: a recorded change that no live delivery covers yet. */
function receiptChangeDue(install: InstallState): boolean {
  const r = install.receipt!;
  if (install.pendingChangeAt === null) return false;
  const outstanding = r.outstanding;
  // A live burst carries the newest generation on its next attempt; an exhausted one is reopened
  // only by a newer change, so one dead phone costs a bounded burst per real calendar edit.
  return !outstanding || (outstanding.nextAt === null && r.generation > outstanding.generation);
}

function receiptRetryAt(install: InstallState): number | null {
  return install.receipt?.outstanding?.nextAt ?? null;
}

/**
 * When the shard next needs to look at this install (`next`), and when for an alarm precheck or a
 * calendar change (`priority`, visited first). Both null when disabled or nothing is scheduled.
 */
export function wakeTimes(install: InstallState, subscriptions: SubscriptionState[], nowMs: number): { next: number | null; priority: number | null } {
  if (!install.enabled || install.receipt?.eligible === false) return { next: null, priority: null };
  const wake = pushWakeTimes(install, subscriptions, nowMs);
  const ringEnd = nextRingEndAt(install, nowMs);
  if (ringEnd === null) return wake;
  return { next: Math.min(wake.next ?? Infinity, ringEnd), priority: Math.min(wake.priority ?? Infinity, ringEnd) };
}

function pushWakeTimes(install: InstallState, subscriptions: SubscriptionState[], nowMs: number): { next: number | null; priority: number | null } {
  if (install.receipt) {
    const priority: number[] = [receiptRecoveryAt(install, nowMs)];
    const retry = receiptRetryAt(install);
    if (retry !== null) priority.push(Math.max(retry, nowMs));
    const precheck = receiptPrecheckAt(install, nowMs);
    if (precheck !== null) priority.push(precheck);
    if (receiptChangeDue(install)) priority.push(nowMs);
    const candidates = [...priority];
    if (install.freshness.polling) {
      candidates.push(nextActiveTime(Math.max(heartbeatBase(install), install.receipt.lastWakeAt ?? 0) + HEARTBEAT_INTERVAL_MS, install.freshness));
    }
    for (const subscription of subscriptions) {
      if (subscription.renewDueAt !== null && !isRenewalDead(subscription, nowMs)) candidates.push(Math.max(subscription.renewDueAt, nowMs));
    }
    const blocked = pushBlockedUntil(install);
    return { next: Math.max(Math.min(...candidates), blocked), priority: Math.max(Math.min(...priority), blocked) };
  }
  const priorityCandidates: number[] = [];
  if (install.pendingChangeAt !== null) priorityCandidates.push(nowMs);
  const precheck = nextPrecheckAt(install, nowMs);
  if (precheck !== null) priorityCandidates.push(precheck);

  const candidates = [...priorityCandidates];
  if (install.freshness.polling) {
    candidates.push(nextActiveTime(Math.max(heartbeatBase(install) + HEARTBEAT_INTERVAL_MS, nowMs), install.freshness));
  }
  for (const subscription of subscriptions) {
    if (subscription.renewDueAt !== null) candidates.push(Math.max(subscription.renewDueAt, nowMs));
  }
  const blocked = pushBlockedUntil(install);
  const at = (values: number[]) => (values.length > 0 ? Math.max(Math.min(...values), blocked) : null);
  return { next: at(candidates), priority: at(priorityCandidates) };
}

/**
 * Chooses the single push to send for an install now, or null. A meeting window or stage opening
 * within the coalescing window upgrades a due heartbeat to a priority-10 precheck.
 */
export function planPush(install: InstallState, subscriptions: SubscriptionState[], nowMs: number): PushPlan | null {
  if (!install.enabled || install.receipt?.eligible === false) return null;
  if (dueRingEnds(install, nowMs).length > 0 && nowMs >= ringEndBlockedUntil(install)) {
    return { kind: "ringEnd", ...(install.pendingChangeProvider ? { provider: install.pendingChangeProvider } : {}), renewalKeys: [] };
  }
  if (!canSendNow(install, nowMs)) return null;
  if (install.receipt) {
    const dueRenewals = subscriptions.filter((subscription) => isRenewalDue(subscription, nowMs));
    const retry = receiptRetryAt(install);
    const retryDue = (retry !== null && retry <= nowMs) || receiptChangeDue(install);
    const recoveryDue = receiptRecoveryAt(install, nowMs) <= nowMs;
    const precheck = receiptPrecheckAt(install, nowMs);
    const kind: PushKind | null =
      precheck !== null && precheck <= nowMs ? "precheck"
      : retryDue ? "change"
      : dueRenewals.length > 0 ? "renew"
      : recoveryDue ? "precheck"
      : install.freshness.polling && nowMs - Math.max(heartbeatBase(install), install.receipt.lastWakeAt ?? 0) >= HEARTBEAT_INTERVAL_MS
        && isWithinActiveHours(nowMs, install.freshness) ? "heartbeat"
      : null;
    if (!kind) return null;
    return {
      kind,
      ...(install.pendingChangeProvider ? { provider: install.pendingChangeProvider } : {}),
      renewalKeys: kind === "renew" ? dueRenewals.map((subscription) => subscription.key) : [],
      burst: retryDue || recoveryDue,
    };
  }
  const dueRenewals = subscriptions.filter((subscription) => isRenewalDue(subscription, nowMs));
  const candidates: Record<PushKind, boolean> = {
    ringEnd: false,
    precheck: install.freshness.polling ? isMeetingWindowDue(install, nowMs) : dueStages(install, nowMs).length > 0,
    change: install.pendingChangeAt !== null,
    renew: dueRenewals.length > 0,
    heartbeat: isHeartbeatDue(install, nowMs),
  };
  let kind = KIND_ORDER.find((candidate) => candidates[candidate]);
  if (!kind) return null;
  if (kind === "heartbeat" && isMeetingWindowDue(install, nowMs, { lookaheadMs: COALESCE_MS })) kind = "precheck";
  let provider: Provider | undefined;
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

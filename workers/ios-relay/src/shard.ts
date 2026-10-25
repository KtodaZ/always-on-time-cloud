// InstallShard: one of SHARD_COUNT Durable Objects (SQLite storage). A shard holds
//  - the installs whose ID hashes to it, with their alarm triggers, subscriptions, push
//    bookkeeping and per-install rate limit, and sends their pushes from its DO alarm;
//  - the subscription index entries (subscription key -> install ID) whose key hashes to it, so a
//    webhook finds its install without scanning;
//  - registration rate-limit counters whose key hashes to it.
// Every push costs only SQLite writes inside the shard; there is no external database.

import { DurableObject } from "cloudflare:workers";

import { ApnsConfigError, sendRelayPush, type ApnsEnvironment, type ApnsResult } from "./apns";
import { apnsConfigFromEnv, sharedProviderToken } from "./apns-token";
import type { Env } from "./env";
import {
  DAY_MS,
  MINUTE_MS,
  failureBackoffMs,
  freshAt,
  initialRenewDueAt,
  isRenewalDead,
  isRenewalDue,
  planPush,
  renewRetryAt,
  stagesSatisfiedByPush,
  stagesSatisfiedBySync,
  wakeTimes,
  type AlarmState,
  type Freshness,
  type InstallState,
  type Provider,
  type PushPlan,
  type Stage,
  type SubscriptionState,
} from "./schedule";
import { errorName, forEachLimited, log, safeEqualHex, shardFor } from "./util";

export const MAX_SUBSCRIPTIONS_PER_INSTALL = 64;
/** Live plus expired-but-retained mappings per install; the oldest expired ones go first. */
export const MAX_STORED_SUBSCRIPTIONS_PER_INSTALL = 2 * MAX_SUBSCRIPTIONS_PER_INSTALL;
export const DISABLED_INSTALL_RETENTION_MS = 30 * DAY_MS;
/** Expired mappings are kept so late Graph lifecycle events can still be verified and routed. */
export const EXPIRED_SUBSCRIPTION_RETENTION_MS = 7 * DAY_MS;
/** Alarm triggers this far in the past are deleted (snapshots normally replace them first). */
const PAST_ALARM_RETENTION_MS = DAY_MS;
export const INSTALL_RATE = Object.freeze({ limit: 60, windowMs: MINUTE_MS });
/** Pushes per alarm run (one APNs subrequest each); more due work continues in the next run. */
/** Upper bound on pushes per alarm run, whatever the subrequest budget (keeps runs short). */
export const PUSH_BATCH_SIZE = 200;
const PUSH_CONCURRENCY = 8;
const PRUNE_INSTALLS_PER_RUN = 20;
/** Default and floor for MAX_SUBREQUESTS_PER_RUN; 40 fits the Workers Free limit of 50. */
export const DEFAULT_SUBREQUESTS_PER_RUN = 40;
const MIN_SUBREQUESTS_PER_RUN = 10;
/** Worst case per push: the APNs request and its one retry. */
const SUBREQUESTS_PER_PUSH = 2;
/** Per run: fetching the shared provider token and reporting a rejected one. */
const TOKEN_SUBREQUESTS = 2;
/** Prune index releases may use at most this share of a run's budget (at least one install). */
const PRUNE_BUDGET_SHARE = 0.25;
/**
 * A webhook that finds an index entry without its subscription releases the entry only once it is
 * this old: a subscription PUT writes the index entry just before the mapping, and a webhook (often
 * Google's `sync`) can arrive in between.
 */
export const INDEX_RELEASE_GRACE_MS = 5 * MINUTE_MS;

/** Pushes one alarm run may send within `budget` outbound calls after `pruneCalls` were used. */
export function pushesPerRun(budget: number, pruneCalls = 0): number {
  return Math.min(PUSH_BATCH_SIZE, Math.max(1, Math.floor((budget - pruneCalls - TOKEN_SUBREQUESTS) / SUBREQUESTS_PER_PUSH)));
}

/** The configured per-run subrequest budget. */
export function subrequestBudget(env: Pick<Env, "MAX_SUBREQUESTS_PER_RUN">): number {
  const value = Number(env.MAX_SUBREQUESTS_PER_RUN);
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_SUBREQUESTS_PER_RUN;
  return Math.max(MIN_SUBREQUESTS_PER_RUN, value);
}

export interface RegistrationInput {
  apnsToken: string;
  environment: ApnsEnvironment;
  freshness: Freshness;
}

export interface StoredSubscriptionInput {
  provider: Provider;
  resourceIdHash: string | null;
  verificationHash: string;
  expiresAt: number;
}

export type DeviceOp =
  | { kind: "authorize" }
  | { kind: "update"; fields: RegistrationInput }
  | { kind: "delete" }
  | { kind: "alarms"; alarms: Array<{ key: string; triggerAt: number }> }
  | { kind: "synced"; syncedAt: number }
  | { kind: "deleteSubscription"; key: string };

export type DeviceResult =
  | { status: "unauthorized" }
  | { status: "rate-limited" }
  | { status: "ok"; releasedKeys: string[] };

export type GoogleOutcome = "missing" | "expired" | "forbidden" | "ignored" | "recorded";

export interface GraphItem {
  installId: string;
  key: string;
  clientStateHash: string;
  lifecycleEvent: string | null;
}

export interface GraphOutcome {
  missing: Array<{ key: string; installId: string }>;
  mismatches: number;
  late: number;
  installs: number;
}

type InstallRow = {
  install_id: string;
  secret_hash: string;
  apns_token: string;
  apns_environment: ApnsEnvironment;
  polling: number;
  active_start: string;
  active_end: string;
  time_zone: string;
  enabled: number;
  disabled_at: number | null;
  disabled_reason: string | null;
  created_at: number;
  updated_at: number;
  last_push_at: number | null;
  last_push_kind: string | null;
  last_sync_at: number | null;
  pending_change_at: number | null;
  pending_change_provider: Provider | null;
  failure_count: number;
  retry_after: number | null;
  rate_window_start: number | null;
  rate_count: number;
  next_wake_at: number | null;
  priority_wake_at: number | null;
};

type SubscriptionRow = {
  sub_key: string;
  install_id: string;
  provider: Provider;
  resource_id_hash: string | null;
  verification_hash: string;
  expires_at: number;
  renew_due_at: number | null;
  renewal_requested_at: number | null;
};

interface Claim {
  installId: string;
  claimId: string;
  apnsToken: string;
  environment: ApnsEnvironment;
  plan: PushPlan;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS installs (
  install_id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  apns_token TEXT NOT NULL,
  apns_environment TEXT NOT NULL,
  polling INTEGER NOT NULL,
  active_start TEXT NOT NULL,
  active_end TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  disabled_at INTEGER,
  disabled_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_push_at INTEGER,
  last_push_kind TEXT,
  last_sync_at INTEGER,
  pending_change_at INTEGER,
  pending_change_provider TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  retry_after INTEGER,
  rate_window_start INTEGER,
  rate_count INTEGER NOT NULL DEFAULT 0,
  next_wake_at INTEGER,
  priority_wake_at INTEGER
);
CREATE INDEX IF NOT EXISTS installs_next_wake ON installs (next_wake_at) WHERE next_wake_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS installs_disabled ON installs (disabled_at) WHERE disabled_at IS NOT NULL;
-- Shards created by the first deploy had a priority index; it only cost writes.
DROP INDEX IF EXISTS installs_priority_wake;
CREATE TABLE IF NOT EXISTS alarms (
  install_id TEXT NOT NULL,
  alarm_key TEXT NOT NULL,
  trigger_at INTEGER NOT NULL,
  sent_t20 INTEGER,
  sent_t8 INTEGER,
  PRIMARY KEY (install_id, alarm_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS alarms_trigger ON alarms (trigger_at);
CREATE TABLE IF NOT EXISTS subscriptions (
  sub_key TEXT PRIMARY KEY,
  install_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  resource_id_hash TEXT,
  verification_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  renew_due_at INTEGER,
  renewal_requested_at INTEGER,
  last_renew_push_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS subscriptions_install ON subscriptions (install_id);
CREATE INDEX IF NOT EXISTS subscriptions_expires ON subscriptions (expires_at);
CREATE TABLE IF NOT EXISTS sub_index (
  sub_key TEXT PRIMARY KEY,
  install_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sub_index_expires ON sub_index (expires_at);
CREATE TABLE IF NOT EXISTS rate_limits (
  key_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_expires ON rate_limits (expires_at);
`;

/** Registration fields; registering again re-enables an install that APNs disabled. */
function registrationPatch(fields: RegistrationInput, nowMs: number): InstallPatch {
  return {
    apns_token: fields.apnsToken,
    apns_environment: fields.environment,
    polling: fields.freshness.polling ? 1 : 0,
    active_start: fields.freshness.activeHours.start,
    active_end: fields.freshness.activeHours.end,
    time_zone: fields.freshness.timeZone,
    enabled: 1,
    disabled_at: null,
    disabled_reason: null,
    failure_count: 0,
    retry_after: null,
    updated_at: nowMs,
  };
}

function toSubscriptionState(row: SubscriptionRow): SubscriptionState {
  return {
    key: row.sub_key,
    provider: row.provider,
    expiresAt: row.expires_at,
    renewDueAt: row.renew_due_at,
    renewalRequestedAt: row.renewal_requested_at,
  };
}

type InstallPatch = Partial<Omit<InstallRow, "install_id" | "secret_hash" | "created_at" | "next_wake_at" | "priority_wake_at">>;

export class InstallShard extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /**
   * Pushes in flight, by install. Only this object sends its installs' pushes and an alarm run
   * waits for all of them, so the claim lives in memory; if the object restarts mid-push the claim
   * is simply gone. Keeping it out of SQLite saves a row write per push.
   */
  private readonly inFlight = new Map<string, { claimId: string; at: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  /** Current time; a method so tests can control it. */
  protected now(): number {
    return Date.now();
  }

  // --- Install records ---------------------------------------------------------------------

  private installRow(installId: string): InstallRow | null {
    return this.sql.exec<InstallRow>("SELECT * FROM installs WHERE install_id = ?", installId).toArray()[0] ?? null;
  }

  private alarmStates(installId: string): AlarmState[] {
    return this.sql
      .exec<{ alarm_key: string; trigger_at: number; sent_t20: number | null; sent_t8: number | null }>(
        "SELECT alarm_key, trigger_at, sent_t20, sent_t8 FROM alarms WHERE install_id = ?",
        installId,
      )
      .toArray()
      .map((row) => ({ key: row.alarm_key, triggerAt: row.trigger_at, sentT20: row.sent_t20, sentT8: row.sent_t8 }));
  }

  private subscriptionRows(installId: string): SubscriptionRow[] {
    return this.sql.exec<SubscriptionRow>("SELECT * FROM subscriptions WHERE install_id = ?", installId).toArray();
  }

  private installState(row: InstallRow): InstallState {
    return {
      enabled: row.enabled === 1,
      freshness: { polling: row.polling === 1, activeHours: { start: row.active_start, end: row.active_end }, timeZone: row.time_zone },
      createdAt: row.created_at,
      lastPushAt: row.last_push_at,
      lastSyncAt: row.last_sync_at,
      pendingChangeAt: row.pending_change_at,
      pendingChangeProvider: row.pending_change_provider,
      claimedAt: this.inFlight.get(row.install_id)?.at ?? null,
      retryAfter: row.retry_after,
      alarms: this.alarmStates(row.install_id),
    };
  }

  /**
   * Applies `patch` to an install and recomputes its wake times, in a single UPDATE that writes
   * only the columns that change (each row written is billed, so state changes are batched here).
   * Alarm and subscription rows must already be written. Returns the new `next_wake_at`.
   */
  private updateInstall(installId: string, patch: InstallPatch, nowMs: number): number | null {
    const row = this.installRow(installId);
    if (!row) return null;
    const merged: InstallRow = { ...row, ...patch };
    const subscriptions = this.subscriptionRows(installId).map(toSubscriptionState);
    const wake = wakeTimes(this.installState(merged), subscriptions, nowMs);
    const changes: Array<[string, SqlStorageValue]> = [];
    for (const [column, value] of Object.entries(patch)) {
      if (row[column as keyof InstallRow] !== value) changes.push([column, value as SqlStorageValue]);
    }
    if (wake.next !== row.next_wake_at) changes.push(["next_wake_at", wake.next]);
    if (wake.priority !== row.priority_wake_at) changes.push(["priority_wake_at", wake.priority]);
    if (changes.length > 0) {
      this.sql.exec(
        `UPDATE installs SET ${changes.map(([column]) => `${column} = ?`).join(", ")} WHERE install_id = ?`,
        ...changes.map(([, value]) => value), installId,
      );
    }
    return wake.next;
  }

  /** Sets the DO alarm to the earliest install wake or pruning time; deletes it when idle. */
  private async reschedule(): Promise<void> {
    const nowMs = this.now();
    const candidates: number[] = [];
    const wake = this.sql.exec<{ at: number | null }>("SELECT MIN(next_wake_at) AS at FROM installs WHERE next_wake_at IS NOT NULL").one().at;
    if (wake !== null) candidates.push(wake);
    const prune = this.nextPruneAt();
    if (prune !== null) candidates.push(Math.max(prune, nowMs));
    const current = await this.ctx.storage.getAlarm();
    if (candidates.length === 0) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const next = Math.min(...candidates);
    if (current !== next) await this.ctx.storage.setAlarm(next);
  }

  installExists(installId: string): boolean {
    return this.installRow(installId) !== null;
  }

  /** Creates an install, or updates it when the same secret retries; re-enables a disabled one. */
  async register(installId: string, secretHash: string, fields: RegistrationInput): Promise<"created" | "updated" | "conflict"> {
    const nowMs = this.now();
    const existing = this.installRow(installId);
    if (existing) {
      if (!safeEqualHex(secretHash, existing.secret_hash)) return "conflict";
      this.updateInstall(installId, registrationPatch(fields, nowMs), nowMs);
    } else {
      this.sql.exec(
        `INSERT INTO installs (install_id, secret_hash, apns_token, apns_environment, polling, active_start, active_end,
           time_zone, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        installId, secretHash, fields.apnsToken, fields.environment, fields.freshness.polling ? 1 : 0,
        fields.freshness.activeHours.start, fields.freshness.activeHours.end, fields.freshness.timeZone, nowMs, nowMs,
      );
      this.updateInstall(installId, {}, nowMs);
    }
    await this.reschedule();
    return existing ? "updated" : "created";
  }

  /**
   * Verifies the install secret, consumes one unit of the per-install rate limit, then applies
   * `op`. All in one step, so nothing interleaves between the check and the change.
   */
  async device(installId: string, secretHash: string, op: DeviceOp): Promise<DeviceResult> {
    const nowMs = this.now();
    const row = this.installRow(installId);
    if (!row || !safeEqualHex(secretHash, row.secret_hash)) return { status: "unauthorized" };
    const windowExpired = row.rate_window_start === null || nowMs - row.rate_window_start >= INSTALL_RATE.windowMs;
    if (!windowExpired && row.rate_count >= INSTALL_RATE.limit) return { status: "rate-limited" };
    const rate: InstallPatch = windowExpired ? { rate_window_start: nowMs, rate_count: 1 } : { rate_count: row.rate_count + 1 };

    let releasedKeys: string[] = [];
    let patch: InstallPatch = {};
    switch (op.kind) {
      case "authorize":
        break;
      case "update":
        patch = registrationPatch(op.fields, nowMs);
        break;
      case "delete":
        releasedKeys = this.deleteInstallRecords(installId);
        break;
      case "alarms":
        this.replaceAlarms(installId, op.alarms);
        break;
      case "synced":
        patch = this.syncPatch(row, op.syncedAt);
        break;
      case "deleteSubscription": {
        const deleted = this.sql.exec("DELETE FROM subscriptions WHERE sub_key = ? AND install_id = ?", op.key, installId).rowsWritten;
        if (deleted > 0) releasedKeys = [op.key];
        break;
      }
    }
    if (op.kind !== "delete") this.updateInstall(installId, { ...rate, ...patch }, nowMs);
    if (op.kind !== "authorize") await this.reschedule();
    return { status: "ok", releasedKeys };
  }

  /** Deletes an install with its alarms and subscriptions; returns the subscription keys. */
  private deleteInstallRecords(installId: string): string[] {
    const keys = this.sql.exec<{ sub_key: string }>("SELECT sub_key FROM subscriptions WHERE install_id = ?", installId).toArray().map((row) => row.sub_key);
    this.sql.exec("DELETE FROM subscriptions WHERE install_id = ?", installId);
    this.sql.exec("DELETE FROM alarms WHERE install_id = ?", installId);
    this.sql.exec("DELETE FROM installs WHERE install_id = ?", installId);
    return keys;
  }

  /**
   * Replaces the alarm snapshot, keeping sent-stage markers only for unchanged triggers. Writes
   * only the rows that differ, since re-sent snapshots are mostly unchanged.
   */
  private replaceAlarms(installId: string, alarms: Array<{ key: string; triggerAt: number }>): void {
    const prior = new Map(this.alarmStates(installId).map((alarm) => [alarm.key, alarm]));
    const next = new Set(alarms.map((alarm) => alarm.key));
    for (const key of prior.keys()) {
      if (!next.has(key)) this.sql.exec("DELETE FROM alarms WHERE install_id = ? AND alarm_key = ?", installId, key);
    }
    for (const alarm of alarms) {
      const previous = prior.get(alarm.key);
      if (previous?.triggerAt === alarm.triggerAt) continue;
      this.sql.exec(
        `INSERT INTO alarms (install_id, alarm_key, trigger_at, sent_t20, sent_t8) VALUES (?, ?, ?, NULL, NULL)
         ON CONFLICT (install_id, alarm_key) DO UPDATE SET trigger_at = excluded.trigger_at, sent_t20 = NULL, sent_t8 = NULL`,
        installId, alarm.key, alarm.triggerAt,
      );
    }
  }

  /**
   * A full device sync not caused by a relay push. Counts like an accepted push for freshness:
   * resets the heartbeat clock and the meeting-window gap, satisfies precheck stages that started
   * at or before it and changes recorded at or before it. Renewals and coalescing are unaffected.
   */
  private syncPatch(row: InstallRow, syncedAt: number): InstallPatch {
    const state = this.installState(row);
    const fresh = freshAt(state);
    if (fresh !== null && syncedAt <= fresh) return {};
    this.markStages(row.install_id, stagesSatisfiedBySync(state, syncedAt), syncedAt);
    const changeCovered = row.pending_change_at !== null && row.pending_change_at <= syncedAt;
    return { last_sync_at: syncedAt, ...(changeCovered ? { pending_change_at: null, pending_change_provider: null } : {}) };
  }

  private markStages(installId: string, stages: Array<{ key: string; stage: Stage }>, at: number): void {
    for (const { key, stage } of stages) {
      const column = stage === "t20" ? "sent_t20" : "sent_t8";
      this.sql.exec(`UPDATE alarms SET ${column} = ? WHERE install_id = ? AND alarm_key = ?`, at, installId, key);
    }
  }

  // --- Subscriptions -----------------------------------------------------------------------

  /**
   * Creates or replaces a subscription mapping for an install (already authorized by the caller,
   * which also claimed the index entry). `droppedKeys` are expired mappings removed to stay within
   * the stored cap; their index entries should be released.
   */
  async upsertSubscription(installId: string, key: string, input: StoredSubscriptionInput):
    Promise<{ status: "ok"; droppedKeys: string[] } | { status: "limit" } | { status: "unknown-install" }> {
    const nowMs = this.now();
    if (!this.installRow(installId)) return { status: "unknown-install" };
    const owned = this.subscriptionRows(installId);
    const existing = owned.find((row) => row.sub_key === key);
    const others = owned.filter((row) => row.sub_key !== key);
    // Expired mappings kept for late lifecycle events do not count against the live limit.
    const live = others.filter((row) => row.expires_at > nowMs).length;
    if (live >= MAX_SUBSCRIPTIONS_PER_INSTALL && !(existing && existing.expires_at > nowMs)) return { status: "limit" };
    const droppedKeys: string[] = [];
    const excess = others.length + 1 - MAX_STORED_SUBSCRIPTIONS_PER_INSTALL;
    if (excess > 0) {
      const expired = others.filter((row) => row.expires_at <= nowMs).sort((left, right) => left.expires_at - right.expires_at);
      for (const row of expired.slice(0, excess)) {
        this.sql.exec("DELETE FROM subscriptions WHERE sub_key = ?", row.sub_key);
        droppedKeys.push(row.sub_key);
      }
    }
    // A key owned by another install in this shard is replaced: the index (checked by the caller)
    // is the authority on ownership.
    this.sql.exec(
      `INSERT INTO subscriptions (sub_key, install_id, provider, resource_id_hash, verification_hash, expires_at,
         renew_due_at, renewal_requested_at, last_renew_push_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT (sub_key) DO UPDATE SET install_id = excluded.install_id, provider = excluded.provider,
         resource_id_hash = excluded.resource_id_hash, verification_hash = excluded.verification_hash,
         expires_at = excluded.expires_at, renew_due_at = excluded.renew_due_at, renewal_requested_at = NULL,
         updated_at = excluded.updated_at`,
      key, installId, input.provider, input.resourceIdHash, input.verificationHash, input.expiresAt,
      initialRenewDueAt(input.expiresAt), nowMs, nowMs,
    );
    this.updateInstall(installId, {}, nowMs);
    await this.reschedule();
    return { status: "ok", droppedKeys };
  }

  ownsSubscription(installId: string, key: string): boolean {
    return this.sql.exec("SELECT 1 FROM subscriptions WHERE sub_key = ? AND install_id = ?", key, installId).toArray().length > 0;
  }

  private subscriptionRow(installId: string, key: string): SubscriptionRow | null {
    return this.sql.exec<SubscriptionRow>("SELECT * FROM subscriptions WHERE sub_key = ? AND install_id = ?", key, installId).toArray()[0] ?? null;
  }

  /**
   * The patch that marks a provider change. A push covers only changes recorded at or before its
   * send time, so a change arriving while a push is in flight stays pending.
   */
  private changePatch(row: InstallRow, provider: Provider, nowMs: number): InstallPatch {
    return { pending_change_at: Math.max(row.pending_change_at ?? 0, nowMs), pending_change_provider: provider };
  }

  /** Google channel notification, after the index named the install. */
  async googleNotify(input: { installId: string; key: string; tokenHash: string | null; resourceIdHash: string; state: string }): Promise<GoogleOutcome> {
    const nowMs = this.now();
    const subscription = this.subscriptionRow(input.installId, input.key);
    if (!subscription || subscription.provider !== "google") return "missing";
    if (subscription.expires_at <= nowMs) return "expired";
    if (!safeEqualHex(input.tokenHash, subscription.verification_hash)) return "forbidden";
    if (!safeEqualHex(input.resourceIdHash, subscription.resource_id_hash)) return "ignored";
    if (input.state !== "exists" && input.state !== "not_exists") return "ignored";
    const row = this.installRow(input.installId);
    if (!row || row.enabled !== 1) return "ignored";
    this.updateInstall(input.installId, this.changePatch(row, "google", nowMs), nowMs);
    await this.reschedule();
    return "recorded";
  }

  /**
   * Graph notifications for installs in this shard, after the index named each install. Records
   * changes and renewal requests; the push goes out from the shard alarm, never from the request.
   */
  async graphNotify(items: GraphItem[]): Promise<GraphOutcome> {
    const nowMs = this.now();
    const outcome: GraphOutcome = { missing: [], mismatches: 0, late: 0, installs: 0 };
    const changes = new Set<string>();
    const renewals = new Map<string, Set<string>>();
    for (const item of items) {
      const subscription = this.subscriptionRow(item.installId, item.key);
      if (!subscription || subscription.provider !== "microsoft") {
        outcome.missing.push({ key: item.key, installId: item.installId });
        continue;
      }
      // Past the recorded expiry Graph can still send lifecycle events for a subscription the
      // device renewed without telling the relay (or that Graph removed); route those.
      const expired = subscription.expires_at <= nowMs;
      const lifecycle = item.lifecycleEvent;
      if (expired && !(lifecycle === "reauthorizationRequired" || lifecycle === "subscriptionRemoved" || lifecycle === "missed")) continue;
      if (!safeEqualHex(item.clientStateHash, subscription.verification_hash)) {
        outcome.mismatches += 1;
        continue;
      }
      if (expired) outcome.late += 1;
      if (lifecycle === "reauthorizationRequired" || lifecycle === "subscriptionRemoved") {
        if (!renewals.has(item.installId)) renewals.set(item.installId, new Set());
        renewals.get(item.installId)?.add(item.key);
      } else if (lifecycle === null || lifecycle === "missed") {
        changes.add(item.installId);
      }
    }
    for (const installId of new Set([...changes, ...renewals.keys()])) {
      const row = this.installRow(installId);
      if (!row || row.enabled !== 1) continue;
      for (const key of renewals.get(installId) ?? []) {
        this.sql.exec(
          "UPDATE subscriptions SET renewal_requested_at = ?, renew_due_at = ? WHERE sub_key = ? AND install_id = ?",
          nowMs, nowMs, key, installId,
        );
      }
      this.updateInstall(installId, changes.has(installId) ? this.changePatch(row, "microsoft", nowMs) : {}, nowMs);
      outcome.installs += 1;
    }
    if (outcome.installs > 0) await this.reschedule();
    return outcome;
  }

  // --- Subscription index ------------------------------------------------------------------

  /**
   * Claims `key` for `installId` in this shard's index. Another owner is replaced only when it is
   * `replaceOwner` (the caller checked that it no longer holds the subscription).
   */
  async indexClaim(key: string, installId: string, expiresAt: number, replaceOwner: string | null = null):
    Promise<{ status: "ok"; created: boolean } | { status: "conflict"; ownerId: string }> {
    const nowMs = this.now();
    const row = this.sql.exec<{ install_id: string }>("SELECT install_id FROM sub_index WHERE sub_key = ?", key).toArray()[0];
    if (row && row.install_id !== installId && row.install_id !== replaceOwner) return { status: "conflict", ownerId: row.install_id };
    this.sql.exec(
      `INSERT INTO sub_index (sub_key, install_id, expires_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (sub_key) DO UPDATE SET install_id = excluded.install_id, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      key, installId, expiresAt, nowMs,
    );
    await this.reschedule();
    return { status: "ok", created: row?.install_id !== installId };
  }

  indexLookup(keys: string[]): Record<string, string> {
    const owners: Record<string, string> = {};
    for (const key of keys) {
      const row = this.sql.exec<{ install_id: string }>("SELECT install_id FROM sub_index WHERE sub_key = ?", key).toArray()[0];
      if (row) owners[key] = row.install_id;
    }
    return owners;
  }

  /**
   * Removes index entries, each only if it still names that install. With `minAgeMs`, only entries
   * last claimed at least that long ago (see INDEX_RELEASE_GRACE_MS).
   */
  indexRelease(entries: Array<{ key: string; installId: string }>, minAgeMs = 0): number {
    const claimedBefore = this.now() - minAgeMs;
    let removed = 0;
    for (const { key, installId } of entries) {
      removed += this.sql.exec(
        "DELETE FROM sub_index WHERE sub_key = ? AND install_id = ? AND updated_at <= ?", key, installId, claimedBefore,
      ).rowsWritten;
    }
    return removed;
  }

  // --- Registration rate limits ------------------------------------------------------------

  /** Fixed-window counter. Returns false when the window's limit is used up. */
  async consumeRate(keyHash: string, limit: number, windowMs: number): Promise<boolean> {
    const nowMs = this.now();
    const row = this.sql.exec<{ window_start: number; count: number }>("SELECT window_start, count FROM rate_limits WHERE key_hash = ?", keyHash).toArray()[0];
    if (!row || nowMs - row.window_start >= windowMs) {
      this.sql.exec(
        `INSERT INTO rate_limits (key_hash, window_start, count, expires_at) VALUES (?, ?, 1, ?)
         ON CONFLICT (key_hash) DO UPDATE SET window_start = excluded.window_start, count = 1, expires_at = excluded.expires_at`,
        keyHash, nowMs, nowMs + windowMs,
      );
      await this.reschedule();
      return true;
    }
    if (row.count >= limit) return false;
    this.sql.exec("UPDATE rate_limits SET count = count + 1 WHERE key_hash = ?", keyHash);
    return true;
  }

  // --- Push delivery -----------------------------------------------------------------------

  /** Plans the next due push for an install and claims it, or refreshes its wake time. */
  private planAndClaim(installId: string, nowMs: number): Claim | null {
    const row = this.installRow(installId);
    // An in-flight claim blocks planning until it is CLAIM_STALE_MS old; then it can be taken over.
    if (!row) return null;
    // A mapping past its expiry with no lifecycle request is never due again.
    for (const subscription of this.subscriptionRows(installId)) {
      if (isRenewalDead(toSubscriptionState(subscription), nowMs)) {
        this.sql.exec("UPDATE subscriptions SET renew_due_at = NULL WHERE sub_key = ?", subscription.sub_key);
      }
    }
    const subscriptions = this.subscriptionRows(installId).map(toSubscriptionState);
    const plan = row.enabled === 1 ? planPush(this.installState(row), subscriptions, nowMs) : null;
    if (!plan) {
      const next = this.updateInstall(installId, {}, nowMs);
      // Never leave an install due with nothing to send, or the alarm would spin.
      if (next !== null && next <= nowMs) {
        this.sql.exec("UPDATE installs SET next_wake_at = ?, priority_wake_at = NULL WHERE install_id = ?", nowMs + MINUTE_MS, installId);
        log("warn", "Install was due with nothing to send", { installId });
      }
      return null;
    }
    // The claim is not written: the outcome below updates the row once.
    const claimId = crypto.randomUUID();
    this.inFlight.set(installId, { claimId, at: nowMs });
    return { installId, claimId, apnsToken: row.apns_token, environment: row.apns_environment, plan };
  }

  /** Releases the in-memory claim; false when it is no longer this claim's. */
  private release(claim: Claim): boolean {
    if (this.inFlight.get(claim.installId)?.claimId !== claim.claimId) return false;
    this.inFlight.delete(claim.installId);
    return true;
  }

  /**
   * Records an APNs-accepted push: satisfies the pending change it covers, the freshness clock,
   * precheck stages due at `sentAt` (looking ahead for priority-10 kinds) and its renewals.
   */
  private completePush(claim: Claim, sentAt: number): void {
    if (!this.release(claim)) return;
    const row = this.installRow(claim.installId);
    if (!row) return;
    this.markStages(claim.installId, stagesSatisfiedByPush(this.installState(row), claim.plan.kind, sentAt), sentAt);
    for (const key of claim.plan.renewalKeys) {
      const subscription = this.subscriptionRow(claim.installId, key);
      if (!subscription || !isRenewalDue(toSubscriptionState(subscription), sentAt)) continue;
      this.sql.exec(
        "UPDATE subscriptions SET last_renew_push_at = ?, renewal_requested_at = NULL, renew_due_at = ? WHERE sub_key = ?",
        sentAt, renewRetryAt(sentAt, subscription.expires_at), key,
      );
    }
    const changeCovered = row.pending_change_at !== null && row.pending_change_at <= sentAt;
    this.updateInstall(claim.installId, {
      last_push_at: sentAt,
      last_push_kind: claim.plan.kind,
      failure_count: 0,
      retry_after: null,
      ...(changeCovered ? { pending_change_at: null, pending_change_provider: null } : {}),
    }, sentAt);
  }

  /** Releases a claim after a transient failure and backs off (1, 2, 4, 8, 16, 30 minutes). */
  private failPush(claim: Claim, nowMs: number): void {
    if (!this.release(claim)) return;
    const row = this.installRow(claim.installId);
    if (!row) return;
    const failureCount = row.failure_count + 1;
    this.updateInstall(claim.installId, { failure_count: failureCount, retry_after: nowMs + failureBackoffMs(failureCount) }, nowMs);
  }

  /** Disables an install whose token APNs rejected, unless it registered a new token meanwhile. */
  private disableInstall(claim: Claim, reason: string, nowMs: number): boolean {
    this.release(claim);
    const row = this.installRow(claim.installId);
    if (!row) return false;
    if (row.apns_token !== claim.apnsToken) {
      this.updateInstall(claim.installId, {}, nowMs);
      return false;
    }
    this.updateInstall(claim.installId, { enabled: 0, disabled_at: nowMs, disabled_reason: reason }, nowMs);
    return true;
  }

  private async deliver(claim: Claim, sentAt: number): Promise<"sent" | "failed" | "disabled"> {
    let result: ApnsResult;
    try {
      result = await sendRelayPush(apnsConfigFromEnv(this.env), sharedProviderToken(this.env, () => this.now()), {
        environment: claim.environment,
        token: claim.apnsToken,
        kind: claim.plan.kind,
        provider: claim.plan.provider,
        at: sentAt,
      });
    } catch (error) {
      this.failPush(claim, this.now());
      log(error instanceof ApnsConfigError ? "error" : "warn", "APNs request failed", { installId: claim.installId, kind: claim.plan.kind, error: errorName(error) });
      return "failed";
    }
    if (result.status === 200) {
      this.completePush(claim, sentAt);
      return "sent";
    }
    if (result.status === 410 || (result.status === 400 && result.reason === "BadDeviceToken")) {
      const reason = result.status === 410 ? "apns_unregistered" : "apns_bad_device_token";
      if (this.disableInstall(claim, reason, this.now())) log("info", "Disabled install after APNs token rejection", { installId: claim.installId, status: result.status });
      return "disabled";
    }
    this.failPush(claim, this.now());
    log("warn", "APNs rejected a push", { installId: claim.installId, kind: claim.plan.kind, status: result.status, reason: result.reason ?? null });
    return "failed";
  }

  /** Plans, claims and sends the next due push for one install. */
  private async processInstall(installId: string): Promise<string> {
    const sentAt = this.now();
    const claim = this.planAndClaim(installId, sentAt);
    if (!claim) return "idle";
    return this.deliver(claim, sentAt);
  }

  /**
   * DO alarm: prune, then send pushes for due installs (prechecks and changes first), as many as
   * MAX_SUBREQUESTS_PER_RUN allows (pushesPerRun); the next run follows immediately when more is
   * due. Never throws, so the runtime does not retry a half-done run.
   */
  override async alarm(): Promise<void> {
    const nowMs = this.now();
    const budget = subrequestBudget(this.env);
    let pruneCalls = 0;
    try {
      pruneCalls = await this.prune(nowMs, Math.floor(budget * PRUNE_BUDGET_SHARE));
    } catch (error) {
      log("warn", "Pruning failed", { error: errorName(error) });
    }
    const pushLimit = pushesPerRun(budget, pruneCalls);
    // priority_wake_at is never earlier than next_wake_at, so every install with a precheck or
    // change due is in this range; they go first.
    const ids = this.sql.exec<{ install_id: string }>(
      `SELECT install_id FROM installs WHERE next_wake_at IS NOT NULL AND next_wake_at <= ?
       ORDER BY CASE WHEN priority_wake_at <= ? THEN 0 ELSE 1 END, next_wake_at LIMIT ?`,
      nowMs, nowMs, pushLimit,
    ).toArray().map((row) => row.install_id);
    const counts: Record<string, number> = { installs: ids.length };
    await forEachLimited(ids, PUSH_CONCURRENCY, async (installId) => {
      try {
        const outcome = await this.processInstall(installId);
        counts[outcome] = (counts[outcome] ?? 0) + 1;
      } catch (error) {
        counts.errors = (counts.errors ?? 0) + 1;
        log("warn", "Push processing failed", { installId, error: errorName(error) });
      }
    });
    if (ids.length > 0) log("info", "Shard push pass", counts);
    try {
      await this.reschedule();
    } catch (error) {
      log("error", "Could not reschedule the shard alarm", { error: errorName(error) });
      throw error;
    }
  }

  // --- Retention ---------------------------------------------------------------------------

  private nextPruneAt(): number | null {
    const query = (sql: string) => this.sql.exec<{ at: number | null }>(sql).one().at;
    const candidates = [
      query("SELECT MIN(expires_at) AS at FROM rate_limits"),
      query("SELECT MIN(expires_at) AS at FROM sub_index"),
      query("SELECT MIN(expires_at) AS at FROM subscriptions"),
      query("SELECT MIN(trigger_at) AS at FROM alarms"),
      query("SELECT MIN(disabled_at) AS at FROM installs WHERE disabled_at IS NOT NULL"),
    ];
    const offsets = [0, EXPIRED_SUBSCRIPTION_RETENTION_MS, EXPIRED_SUBSCRIPTION_RETENTION_MS, PAST_ALARM_RETENTION_MS, DISABLED_INSTALL_RETENTION_MS];
    const times = candidates.flatMap((at, index) => (at === null ? [] : [at + offsets[index]]));
    return times.length > 0 ? Math.min(...times) : null;
  }

  /**
   * Deletes expired rate-limit windows, index entries and subscription mappings a week past
   * expiry, old alarm triggers, and installs disabled for 30 days (releasing their index entries
   * in other shards).
   */
  private async prune(nowMs: number, indexCallBudget: number): Promise<number> {
    this.sql.exec("DELETE FROM rate_limits WHERE expires_at <= ?", nowMs);
    this.sql.exec("DELETE FROM sub_index WHERE expires_at <= ?", nowMs - EXPIRED_SUBSCRIPTION_RETENTION_MS);
    this.sql.exec("DELETE FROM subscriptions WHERE expires_at <= ?", nowMs - EXPIRED_SUBSCRIPTION_RETENTION_MS);
    this.sql.exec("DELETE FROM alarms WHERE trigger_at <= ?", nowMs - PAST_ALARM_RETENTION_MS);
    const disabled = this.sql.exec<{ install_id: string }>(
      "SELECT install_id FROM installs WHERE disabled_at IS NOT NULL AND enabled = 0 AND disabled_at <= ? LIMIT ?",
      nowMs - DISABLED_INSTALL_RETENTION_MS, PRUNE_INSTALLS_PER_RUN,
    ).toArray();
    // Each index shard named costs one call; stop at the budget (always making progress) and let
    // the next run, due immediately, continue.
    const released: Array<{ key: string; installId: string }> = [];
    const shards = new Set<string>();
    let deleted = 0;
    for (const { install_id: installId } of disabled) {
      const keys = this.sql.exec<{ sub_key: string }>("SELECT sub_key FROM subscriptions WHERE install_id = ?", installId).toArray().map((row) => row.sub_key);
      const needed = new Set(shards);
      for (const key of keys) needed.add(await shardFor(`subscription:${key}`));
      if (deleted > 0 && needed.size > indexCallBudget) break;
      for (const name of needed) shards.add(name);
      deleted += 1;
      for (const key of this.deleteInstallRecords(installId)) released.push({ key, installId });
    }
    if (released.length > 0) await releaseIndexEntries(this.env, released);
    return shards.size;
  }
}

/** Releases index entries in whichever shards hold them. Best effort: stale entries self-heal. */
export async function releaseIndexEntries(env: Env, entries: Array<{ key: string; installId: string }>, minAgeMs = 0): Promise<void> {
  const byShard = new Map<string, Array<{ key: string; installId: string }>>();
  for (const entry of entries) {
    const name = await shardFor(`subscription:${entry.key}`);
    if (!byShard.has(name)) byShard.set(name, []);
    byShard.get(name)?.push(entry);
  }
  await Promise.all([...byShard].map(async ([name, group]) => {
    try {
      await env.SHARDS.getByName(name).indexRelease(group, minAgeMs);
    } catch (error) {
      log("warn", "Could not release subscription index entries", { error: errorName(error) });
    }
  }));
}

"use strict";

const crypto = require("node:crypto");
const {
  COALESCE_MS,
  computeNextWakeAtMs,
  duePrecheckStages,
  failureBackoffMs,
  initialRenewDueAtMs,
  isRenewalDue,
  planPush,
  renewRetryAtMs,
  canSendNow,
} = require("./ios-push-schedule");

const COLLECTIONS = Object.freeze({
  installs: "iosPushInstalls",
  subscriptions: "iosPushSubscriptions",
  rateLimits: "iosPushRateLimits",
  dispatches: "iosPushDispatches",
});
const MAX_SUBSCRIPTIONS_PER_INSTALL = 64;
// Live plus expired-but-retained mappings per install. Beyond this the oldest expired ones are
// deleted early, so retention can never grow an install's mapping set without bound.
const MAX_STORED_SUBSCRIPTIONS_PER_INSTALL = 2 * MAX_SUBSCRIPTIONS_PER_INSTALL;
const DISABLED_INSTALL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// Expired subscription mappings are kept this long so a Graph lifecycle event that arrives after
// the recorded expiry can still be verified and routed (see isRenewalDue).
const EXPIRED_SUBSCRIPTION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// A dispatch document only asks the delivery trigger to run now; the install record holds the
// work itself, so a dispatch that is never processed is harmless and pruned after this.
const DISPATCH_RETENTION_MS = 60 * 60 * 1000;
// While a dispatch requested this recently may still be on its way, another is not created: the
// delivery reads the install's current state and its due renewals when it runs, so it covers
// work recorded after it was queued.
const DISPATCH_DEDUPE_MS = 30 * 1000;

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function subscriptionDocumentId(provider, subscriptionId) {
  return `${provider}_${sha256Hex(`${provider}:${subscriptionId}`)}`;
}

function alarmKey(opaqueAlarmId) {
  return sha256Hex(opaqueAlarmId);
}

function safeEqualHex(left, right) {
  if (typeof left !== "string" || typeof right !== "string" ||
      !/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

/** Merges a new alarm snapshot, keeping sent-stage markers only for unchanged triggers. */
function mergeAlarms(previous, next) {
  const priorByKey = new Map((previous ?? []).map((alarm) => [alarm.key, alarm]));
  return next.map(({ key, triggerAtMs }) => {
    const prior = priorByKey.get(key);
    return { key, triggerAtMs, sent: prior?.triggerAtMs === triggerAtMs ? (prior.sent ?? {}) : {} };
  });
}

function withNextWake(install, patch, nowMs) {
  const next = { ...install, ...patch };
  return { ...patch, nextWakeAtMs: computeNextWakeAtMs(next, nowMs) };
}

/**
 * Pending changes track the newest uncovered change. A push only covers changes recorded at or
 * before its send time, so a change arriving while a push is in flight stays pending.
 */
function latestChangeAtMs(install, nowMs) {
  return Math.max(Number.isSafeInteger(install.pendingChangeAtMs) ? install.pendingChangeAtMs : 0, nowMs);
}

function resumeRenewals(transaction, documents) {
  for (const document of documents) {
    transaction.update(document.ref, { renewDueAtMs: initialRenewDueAtMs(document.data().expiresAtMs) });
  }
}

/** Registration fields; re-registering re-enables an install disabled by APNs. */
function registrationPatch({ apnsToken, apnsEnvironment, heartbeat }, nowMs) {
  return {
    apnsToken,
    apnsEnvironment,
    heartbeat,
    enabled: true,
    disabledAtMs: null,
    disabledReason: null,
    failureCount: 0,
    retryAfterMs: null,
    updatedAtMs: nowMs,
  };
}

/**
 * Firestore persistence for the relay. All state transitions that affect push timing run in
 * transactions and recompute `nextWakeAtMs`, which the scheduler queries.
 */
class FirestorePushStore {
  constructor(db) {
    this.db = db;
  }

  installRef(installId) {
    return this.db.collection(COLLECTIONS.installs).doc(installId);
  }

  subscriptionRef(key) {
    return this.db.collection(COLLECTIONS.subscriptions).doc(key);
  }

  dispatchRef(dispatchId) {
    return this.db.collection(COLLECTIONS.dispatches).doc(dispatchId);
  }

  /**
   * Creates an install, or updates it when the same secret retries. Returns "created" or
   * "updated"; throws StoreError("install-conflict") when the ID belongs to another secret.
   */
  async registerInstall(installId, { installSecretHash, apnsToken, apnsEnvironment, heartbeat }, nowMs) {
    const ref = this.installRef(installId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (snapshot.exists) {
        const install = snapshot.data();
        if (!safeEqualHex(installSecretHash, install.installSecretHash)) {
          throw new StoreError("install-conflict", "install ID is already registered");
        }
        const paused = install.enabled === true ? [] : await this.pausedRenewals(transaction, installId, nowMs);
        transaction.update(ref, withNextWake(install, registrationPatch({ apnsToken, apnsEnvironment, heartbeat }, nowMs), nowMs));
        resumeRenewals(transaction, paused);
        return "updated";
      }
      const install = {
        installSecretHash,
        apnsToken,
        apnsEnvironment,
        heartbeat,
        enabled: true,
        disabledAtMs: null,
        disabledReason: null,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        alarms: [],
        lastPushAtMs: null,
        pendingChangeAtMs: null,
        pendingChangeProvider: null,
        pushClaimId: null,
        pushClaimedAtMs: null,
        failureCount: 0,
        retryAfterMs: null,
        rateWindowStartMs: null,
        rateCount: 0,
      };
      transaction.set(ref, { ...install, nextWakeAtMs: computeNextWakeAtMs(install, nowMs) });
      return "created";
    });
  }

  /**
   * Verifies the install secret and consumes one unit of the per-install rate limit in a single
   * transaction. Returns "ok", "unauthorized", or "rate-limited".
   */
  async authorizeInstall(installId, secretHash, { limit, windowMs }, nowMs) {
    const ref = this.installRef(installId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || !safeEqualHex(secretHash, snapshot.data().installSecretHash)) return "unauthorized";
      const install = snapshot.data();
      const windowExpired = !Number.isSafeInteger(install.rateWindowStartMs) || nowMs - install.rateWindowStartMs >= windowMs;
      if (windowExpired) {
        transaction.update(ref, { rateWindowStartMs: nowMs, rateCount: 1 });
        return "ok";
      }
      if ((install.rateCount ?? 0) >= limit) return "rate-limited";
      transaction.update(ref, { rateCount: (install.rateCount ?? 0) + 1 });
      return "ok";
    });
  }

  /**
   * Live subscriptions whose renewal schedule was paused while the install was disabled. Expired
   * mappings (kept only for late lifecycle events) stay paused.
   */
  async pausedRenewals(transaction, installId, nowMs) {
    const owned = await transaction.get(
      this.db.collection(COLLECTIONS.subscriptions).where("installId", "==", installId),
    );
    return owned.docs.filter((document) => document.data().renewDueAtMs === null && document.data().expiresAtMs > nowMs);
  }

  /** Keys of the install's subscriptions whose renewal is due now (dispatch delivery). */
  async listInstallRenewalsDue(installId, nowMs) {
    const owned = await this.db.collection(COLLECTIONS.subscriptions).where("installId", "==", installId).get();
    return owned.docs
      .filter((document) => isRenewalDue(document.data(), nowMs))
      .map((document) => document.id);
  }

  async getInstall(installId) {
    const snapshot = await this.installRef(installId).get();
    return snapshot.exists ? { installId, ...snapshot.data() } : null;
  }

  async updateRegistration(installId, { apnsToken, apnsEnvironment, heartbeat }, nowMs) {
    const ref = this.installRef(installId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return false;
      const paused = snapshot.data().enabled === true ? [] : await this.pausedRenewals(transaction, installId, nowMs);
      transaction.update(ref, withNextWake(snapshot.data(), registrationPatch({ apnsToken, apnsEnvironment, heartbeat }, nowMs), nowMs));
      resumeRenewals(transaction, paused);
      return true;
    });
  }

  /**
   * Deletes an install and its subscription mappings. `onlyIf` is checked against the install
   * inside the transaction (used by pruning so a just re-enabled install survives).
   */
  async deleteInstall(installId, { onlyIf = null } = {}) {
    const ref = this.installRef(installId);
    const owned = this.db.collection(COLLECTIONS.subscriptions).where("installId", "==", installId);
    return this.db.runTransaction(async (transaction) => {
      const [installSnapshot, subscriptionSnapshot] = await Promise.all([
        transaction.get(ref),
        transaction.get(owned),
      ]);
      if (onlyIf && !(installSnapshot.exists && onlyIf(installSnapshot.data()))) return false;
      for (const document of subscriptionSnapshot.docs) transaction.delete(document.ref);
      if (installSnapshot.exists) transaction.delete(ref);
      return installSnapshot.exists;
    });
  }

  async replaceAlarms(installId, alarms, nowMs) {
    const ref = this.installRef(installId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return false;
      const install = snapshot.data();
      transaction.update(ref, withNextWake(install, {
        alarms: mergeAlarms(install.alarms, alarms),
        alarmsUpdatedAtMs: nowMs,
      }, nowMs));
      return true;
    });
  }

  async upsertSubscription(key, { installId, provider, resourceId, verificationHash, expiresAtMs }, nowMs) {
    const ref = this.subscriptionRef(key);
    const owned = this.db.collection(COLLECTIONS.subscriptions).where("installId", "==", installId);
    return this.db.runTransaction(async (transaction) => {
      const [existing, ownedSnapshot] = await Promise.all([transaction.get(ref), transaction.get(owned)]);
      if (existing.exists && existing.data().installId !== installId) {
        throw new StoreError("subscription-owner-conflict", "subscription belongs to another install");
      }
      // Expired mappings kept for late lifecycle events do not count against the live limit; a
      // re-PUT of an expired mapping counts as a new one.
      const others = ownedSnapshot.docs.filter((document) => document.id !== key);
      const live = others.filter((document) => document.data().expiresAtMs > nowMs).length;
      if (live >= MAX_SUBSCRIPTIONS_PER_INSTALL &&
          !(existing.exists && existing.data().expiresAtMs > nowMs)) {
        throw new StoreError("subscription-limit", "install subscription limit reached");
      }
      // Bound what is stored: drop the oldest expired mappings beyond the total cap.
      const excess = others.length + 1 - MAX_STORED_SUBSCRIPTIONS_PER_INSTALL;
      if (excess > 0) {
        const expired = others.filter((document) => !(document.data().expiresAtMs > nowMs))
          .sort((left, right) => left.data().expiresAtMs - right.data().expiresAtMs);
        for (const document of expired.slice(0, excess)) transaction.delete(document.ref);
      }
      transaction.set(ref, {
        installId,
        provider,
        ...(provider === "google" ? { resourceIdHash: sha256Hex(resourceId) } : {}),
        verificationHash,
        expiresAtMs,
        expiresAt: new Date(expiresAtMs),
        renewDueAtMs: initialRenewDueAtMs(expiresAtMs),
        renewalRequestedAtMs: null,
        lastRenewPushAtMs: existing.exists ? (existing.data().lastRenewPushAtMs ?? null) : null,
        createdAtMs: existing.exists ? existing.data().createdAtMs : nowMs,
        updatedAtMs: nowMs,
      });
      return existing.exists ? "updated" : "created";
    });
  }

  async getSubscription(key) {
    const snapshot = await this.subscriptionRef(key).get();
    return snapshot.exists ? { key, ...snapshot.data() } : null;
  }

  async removeSubscription(key, installId) {
    const ref = this.subscriptionRef(key);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return false;
      if (snapshot.data().installId !== installId) {
        throw new StoreError("subscription-owner-conflict", "subscription belongs to another install");
      }
      transaction.delete(ref);
      return true;
    });
  }

  async listInstallIdsDue(nowMs, limit) {
    const snapshot = await this.db.collection(COLLECTIONS.installs)
      .where("nextWakeAtMs", "<=", nowMs)
      .orderBy("nextWakeAtMs")
      .limit(limit)
      .get();
    return snapshot.docs.map((document) => document.id);
  }

  async listRenewalsDue(nowMs, limit) {
    const snapshot = await this.db.collection(COLLECTIONS.subscriptions)
      .where("renewDueAtMs", "<=", nowMs)
      .orderBy("renewDueAtMs")
      .limit(limit)
      .get();
    return snapshot.docs.map((document) => ({ key: document.id, ...document.data() }));
  }

  /**
   * Records a provider change for the install and claims a push if coalescing allows one now.
   * The pending marker persists until an accepted push covers it, so a deferred or failed
   * change is retried by the scheduler. Returns { status: "claimed", install, plan, claimId },
   * { status: "deferred" }, or { status: "ignored" }.
   */
  async recordChangeAndClaim(installId, provider, nowMs, claimId) {
    const ref = this.installRef(installId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || snapshot.data().enabled !== true) return { status: "ignored" };
      const install = snapshot.data();
      const pending = {
        pendingChangeAtMs: latestChangeAtMs(install, nowMs),
        pendingChangeProvider: provider,
      };
      if (!canSendNow(install, nowMs)) {
        transaction.update(ref, withNextWake(install, pending, nowMs));
        return { status: "deferred" };
      }
      const claim = { pushClaimId: claimId, pushClaimedAtMs: nowMs };
      transaction.update(ref, withNextWake(install, { ...pending, ...claim }, nowMs));
      return {
        status: "claimed",
        claimId,
        install: { installId, ...install },
        plan: { kind: "change", provider, renewalKeys: [] },
      };
    });
  }

  /**
   * Records verified Graph notifications for one install in a single transaction and, when a push
   * may go out now, queues a dispatch document whose Firestore trigger delivers it. The webhook can
   * then answer within Graph's time limit without calling APNs. Everything the delivery needs is
   * on the install and subscription records, so if the dispatch is skipped (coalescing, a recent
   * dispatch) or lost, the scheduler sends the push instead.
   *
   * `changeProvider` records a pending change; `renewalKeys` are subscription documents that
   * asked for an immediate renewal (`reauthorizationRequired`, `subscriptionRemoved`). Returns
   * "queued", "pending", or "ignored" (unknown or disabled install).
   */
  async recordWebhookNotifications(installId, { changeProvider = null, renewalKeys = [] }, nowMs, dispatchId) {
    const ref = this.installRef(installId);
    const subscriptionRefs = renewalKeys.map((key) => this.subscriptionRef(key));
    return this.db.runTransaction(async (transaction) => {
      const [snapshot, ...subscriptionSnapshots] = await Promise.all([
        transaction.get(ref),
        ...subscriptionRefs.map((subscriptionRef) => transaction.get(subscriptionRef)),
      ]);
      if (!snapshot.exists || snapshot.data().enabled !== true) return "ignored";
      const install = snapshot.data();
      const renewals = subscriptionSnapshots.filter((subscriptionSnapshot) =>
        subscriptionSnapshot.exists && subscriptionSnapshot.data().installId === installId);
      if (!changeProvider && renewals.length === 0) return "ignored";

      const patch = changeProvider
        ? { pendingChangeAtMs: latestChangeAtMs(install, nowMs), pendingChangeProvider: changeProvider }
        : {};
      const lastDispatch = install.dispatchRequestedAtMs;
      const recentlyDispatched = Number.isSafeInteger(lastDispatch) && lastDispatch <= nowMs &&
        nowMs - lastDispatch < DISPATCH_DEDUPE_MS;
      const dispatch = canSendNow(install, nowMs) && !recentlyDispatched;
      if (dispatch) patch.dispatchRequestedAtMs = nowMs;

      for (const subscriptionSnapshot of renewals) {
        transaction.update(subscriptionSnapshot.ref, { renewalRequestedAtMs: nowMs, renewDueAtMs: nowMs });
      }
      if (Object.keys(patch).length > 0) transaction.update(ref, withNextWake(install, patch, nowMs));
      if (dispatch) {
        transaction.set(this.dispatchRef(dispatchId), {
          installId,
          renewalKeys: renewals.map((subscriptionSnapshot) => subscriptionSnapshot.id),
          createdAtMs: nowMs,
          expiresAt: new Date(nowMs + DISPATCH_RETENTION_MS),
        });
      }
      return dispatch ? "queued" : "pending";
    });
  }

  async deleteDispatch(dispatchId) {
    await this.dispatchRef(dispatchId).delete();
  }

  /**
   * Plans and claims the next push for an install (scheduler path). `renewalKeys` are
   * subscription documents the caller found due for renewal. Always refreshes
   * `nextWakeAtMs`. Returns { status: "claimed", install, plan, claimId } or { status: "idle" }.
   */
  async planAndClaim(installId, renewalKeys, nowMs, claimId) {
    const ref = this.installRef(installId);
    const subscriptionRefs = renewalKeys.map((key) => this.subscriptionRef(key));
    return this.db.runTransaction(async (transaction) => {
      const [snapshot, ...subscriptionSnapshots] = await Promise.all([
        transaction.get(ref),
        ...subscriptionRefs.map((subscriptionRef) => transaction.get(subscriptionRef)),
      ]);
      if (!snapshot.exists || snapshot.data().enabled !== true) {
        // Stop orphaned or disabled installs from resurfacing in the scheduler queries.
        for (const subscriptionSnapshot of subscriptionSnapshots) {
          if (!subscriptionSnapshot.exists || subscriptionSnapshot.data().installId !== installId) continue;
          if (snapshot.exists) transaction.update(subscriptionSnapshot.ref, { renewDueAtMs: null });
          else transaction.delete(subscriptionSnapshot.ref);
        }
        if (snapshot.exists && snapshot.data().nextWakeAtMs !== null) transaction.update(ref, { nextWakeAtMs: null });
        return { status: "idle" };
      }
      const install = snapshot.data();
      const owned = subscriptionSnapshots
        .filter((subscriptionSnapshot) => subscriptionSnapshot.exists && subscriptionSnapshot.data().installId === installId);
      const renewals = owned.map((subscriptionSnapshot) => ({ key: subscriptionSnapshot.id, ...subscriptionSnapshot.data() }));
      // A mapping past its expiry with no lifecycle request is never due again; stop listing it
      // while it waits to be pruned.
      for (const subscriptionSnapshot of owned) {
        const subscription = subscriptionSnapshot.data();
        if (Number.isSafeInteger(subscription.renewDueAtMs) && subscription.renewDueAtMs <= nowMs &&
            !isRenewalDue(subscription, nowMs)) {
          transaction.update(subscriptionSnapshot.ref, { renewDueAtMs: null });
        }
      }
      const plan = planPush(install, nowMs, { renewals });
      if (!plan) {
        const nextWakeAtMs = computeNextWakeAtMs(install, nowMs);
        if (nextWakeAtMs !== install.nextWakeAtMs) transaction.update(ref, { nextWakeAtMs });
        return { status: "idle" };
      }
      transaction.update(ref, withNextWake(install, { pushClaimId: claimId, pushClaimedAtMs: nowMs }, nowMs));
      return { status: "claimed", claimId, install: { installId, ...install }, plan };
    });
  }

  /**
   * Records an APNs-accepted push. Any accepted push wakes the NSE for a full sync, so it
   * satisfies a pending change, the heartbeat timer, and precheck stages due at `sentAtMs`
   * (or, for priority-10 pushes, opening within the coalescing window after it).
   */
  async completePush(installId, claimId, plan, sentAtMs) {
    const ref = this.installRef(installId);
    const subscriptionRefs = (plan.renewalKeys ?? []).map((key) => this.subscriptionRef(key));
    return this.db.runTransaction(async (transaction) => {
      const [snapshot, ...subscriptionSnapshots] = await Promise.all([
        transaction.get(ref),
        ...subscriptionRefs.map((subscriptionRef) => transaction.get(subscriptionRef)),
      ]);
      if (!snapshot.exists || snapshot.data().pushClaimId !== claimId) return false;
      const install = snapshot.data();
      // Only a priority-10 push stands in for an upcoming precheck stage (see planPush).
      const lookaheadMs = plan.kind === "heartbeat" ? 0 : COALESCE_MS;
      const dueStages = duePrecheckStages(install.alarms, sentAtMs, { lookaheadMs });
      const alarms = (install.alarms ?? []).map((alarm) => {
        const stages = dueStages.filter((due) => due.key === alarm.key).map((due) => due.stage);
        if (stages.length === 0) return alarm;
        const sent = { ...(alarm.sent ?? {}) };
        for (const stage of stages) sent[stage] = sentAtMs;
        return { ...alarm, sent };
      });
      const changeCovered = Number.isSafeInteger(install.pendingChangeAtMs) && install.pendingChangeAtMs <= sentAtMs;
      transaction.update(ref, withNextWake(install, {
        alarms,
        lastPushAtMs: sentAtMs,
        lastPushKind: plan.kind,
        pushClaimId: null,
        pushClaimedAtMs: null,
        failureCount: 0,
        retryAfterMs: null,
        ...(changeCovered ? { pendingChangeAtMs: null, pendingChangeProvider: null } : {}),
      }, sentAtMs));

      for (const subscriptionSnapshot of subscriptionSnapshots) {
        if (!subscriptionSnapshot.exists) continue;
        const subscription = subscriptionSnapshot.data();
        if (subscription.installId !== installId || !isRenewalDue(subscription, sentAtMs)) continue;
        transaction.update(subscriptionSnapshot.ref, {
          lastRenewPushAtMs: sentAtMs,
          renewalRequestedAtMs: null,
          renewDueAtMs: renewRetryAtMs(sentAtMs, subscription.expiresAtMs),
        });
      }
      return true;
    });
  }

  /** Releases a claim after a transient APNs failure and backs off further attempts. */
  async failPush(installId, claimId, nowMs) {
    const ref = this.installRef(installId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || snapshot.data().pushClaimId !== claimId) return false;
      const install = snapshot.data();
      const failureCount = (install.failureCount ?? 0) + 1;
      transaction.update(ref, withNextWake(install, {
        pushClaimId: null,
        pushClaimedAtMs: null,
        failureCount,
        retryAfterMs: nowMs + failureBackoffMs(failureCount),
      }, nowMs));
      return true;
    });
  }

  /**
   * Disables an install after APNs reports its token invalid, unless the device registered a
   * different token while the push was in flight.
   */
  async disableInstall(installId, claimId, apnsToken, reason, nowMs) {
    const ref = this.installRef(installId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return false;
      const install = snapshot.data();
      const release = install.pushClaimId === claimId ? { pushClaimId: null, pushClaimedAtMs: null } : {};
      if (install.apnsToken !== apnsToken) {
        if (Object.keys(release).length > 0) transaction.update(ref, withNextWake(install, release, nowMs));
        return false;
      }
      transaction.update(ref, {
        ...release,
        enabled: false,
        disabledAtMs: nowMs,
        disabledReason: reason,
        nextWakeAtMs: null,
      });
      return true;
    });
  }

  async consumeRateLimit(key, { limit, windowMs }, nowMs) {
    const ref = this.db.collection(COLLECTIONS.rateLimits).doc(sha256Hex(key));
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const record = snapshot.exists ? snapshot.data() : null;
      if (!record || !Number.isSafeInteger(record.windowStartMs) || nowMs - record.windowStartMs >= windowMs) {
        transaction.set(ref, { windowStartMs: nowMs, count: 1, expiresAt: new Date(nowMs + windowMs) });
        return true;
      }
      if (record.count >= limit) return false;
      transaction.update(ref, { count: record.count + 1 });
      return true;
    });
  }

  /**
   * Deletes expired rate-limit windows and dispatches, subscriptions a week past expiry, and
   * long-disabled installs.
   */
  async pruneExpiredRecords(nowMs, maxPerCollection = 200) {
    const cutoff = new Date(nowMs);
    const subscriptionCutoff = new Date(nowMs - EXPIRED_SUBSCRIPTION_RETENTION_MS);
    const disabledBefore = nowMs - DISABLED_INSTALL_RETENTION_MS;
    const [rates, subscriptions, disabled, dispatches] = await Promise.all([
      this.db.collection(COLLECTIONS.rateLimits).where("expiresAt", "<=", cutoff).limit(maxPerCollection).get(),
      this.db.collection(COLLECTIONS.subscriptions).where("expiresAt", "<=", subscriptionCutoff).limit(maxPerCollection).get(),
      this.db.collection(COLLECTIONS.installs).where("disabledAtMs", "<=", disabledBefore).limit(20).get(),
      this.db.collection(COLLECTIONS.dispatches).where("expiresAt", "<=", cutoff).limit(maxPerCollection).get(),
    ]);
    const deletions = [...rates.docs, ...subscriptions.docs, ...dispatches.docs].map((document) => document.ref);
    if (deletions.length > 0) {
      const batch = this.db.batch();
      for (const ref of deletions) batch.delete(ref);
      await batch.commit();
    }
    let installs = 0;
    for (const document of disabled.docs) {
      const deleted = await this.deleteInstall(document.id, {
        onlyIf: (install) => install.enabled !== true && Number.isSafeInteger(install.disabledAtMs) &&
          install.disabledAtMs <= disabledBefore,
      });
      if (deleted) installs += 1;
    }
    return { rateLimits: rates.size, subscriptions: subscriptions.size, dispatches: dispatches.size, installs };
  }
}

module.exports = {
  COLLECTIONS,
  DISABLED_INSTALL_RETENTION_MS,
  DISPATCH_DEDUPE_MS,
  DISPATCH_RETENTION_MS,
  EXPIRED_SUBSCRIPTION_RETENTION_MS,
  FirestorePushStore,
  MAX_STORED_SUBSCRIPTIONS_PER_INSTALL,
  MAX_SUBSCRIPTIONS_PER_INSTALL,
  StoreError,
  alarmKey,
  mergeAlarms,
  safeEqualHex,
  sha256Hex,
  subscriptionDocumentId,
};

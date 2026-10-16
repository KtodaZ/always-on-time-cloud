"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  COLLECTIONS,
  DISABLED_INSTALL_RETENTION_MS,
  DISPATCH_DEDUPE_MS,
  DISPATCH_RETENTION_MS,
  EXPIRED_SUBSCRIPTION_RETENTION_MS,
  FirestorePushStore,
  MAX_STORED_SUBSCRIPTIONS_PER_INSTALL,
  mergeAlarms,
  sha256Hex,
} = require("../ios-push-firestore");
const { FakeFirestore } = require("../testing/fake-firestore");

const MINUTE = 60 * 1000;
const NOW = Date.parse("2026-10-07T16:00:00.000Z");
const HEARTBEAT = { intervalMinutes: 20, activeHours: { start: "07:00", end: "22:00" }, timeZone: "America/Los_Angeles" };
const INSTALL_ID = "AbCdEfGhIjKlMnOpQrStUv";

async function setup() {
  const db = new FakeFirestore();
  const store = new FirestorePushStore(db);
  await store.registerInstall(INSTALL_ID, {
    installSecretHash: sha256Hex("secret"),
    apnsToken: "ab".repeat(32),
    apnsEnvironment: "development",
    heartbeat: HEARTBEAT,
  }, NOW);
  const install = () => db.documents.get(`${COLLECTIONS.installs}/${INSTALL_ID}`);
  return { db, store, install };
}

test("concurrent provider changes claim exactly one push; the rest stay pending", async () => {
  const { store, install } = await setup();
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, index) => store.recordChangeAndClaim(INSTALL_ID, "google", NOW, `claim-${index}`)),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), ["claimed", "deferred", "deferred", "deferred", "deferred"]);
  const claimed = results.find((result) => result.status === "claimed");
  assert.equal(install().pushClaimId, claimed.claimId);

  await store.completePush(INSTALL_ID, claimed.claimId, claimed.plan, NOW);
  assert.equal(install().pendingChangeAtMs, null, "changes recorded at the send time are covered");
  assert.equal(install().pushClaimId, null);
  assert.equal(install().lastPushAtMs, NOW);
});

test("a change that arrives while a push is in flight stays pending after completion", async () => {
  const { store, install } = await setup();
  const claim = await store.recordChangeAndClaim(INSTALL_ID, "google", NOW, "first");
  const second = await store.recordChangeAndClaim(INSTALL_ID, "microsoft", NOW + 500, "second");
  assert.equal(second.status, "deferred");
  await store.completePush(INSTALL_ID, claim.claimId, claim.plan, NOW);
  assert.equal(install().pendingChangeAtMs, NOW + 500);
  assert.equal(install().pendingChangeProvider, "microsoft");
  assert.equal(install().nextWakeAtMs, NOW + 2 * MINUTE);
});

test("a stale claim from a crashed sender expires after two minutes", async () => {
  const { store } = await setup();
  await store.recordChangeAndClaim(INSTALL_ID, "google", NOW, "crashed");
  assert.equal((await store.recordChangeAndClaim(INSTALL_ID, "google", NOW + MINUTE, "next")).status, "deferred");
  assert.equal((await store.recordChangeAndClaim(INSTALL_ID, "google", NOW + 2 * MINUTE, "next")).status, "claimed");
  assert.equal(await store.completePush(INSTALL_ID, "crashed", { kind: "change", renewalKeys: [] }, NOW), false,
    "the crashed sender can no longer complete");
});

test("alarm merges keep sent markers only for unchanged triggers", () => {
  const previous = [
    { key: "a", triggerAtMs: 100, sent: { t20: 1 } },
    { key: "b", triggerAtMs: 200, sent: { t20: 2, t8: 3 } },
  ];
  assert.deepEqual(mergeAlarms(previous, [{ key: "a", triggerAtMs: 100 }, { key: "b", triggerAtMs: 250 }, { key: "c", triggerAtMs: 300 }]), [
    { key: "a", triggerAtMs: 100, sent: { t20: 1 } },
    { key: "b", triggerAtMs: 250, sent: {} },
    { key: "c", triggerAtMs: 300, sent: {} },
  ]);
});

test("planAndClaim refreshes nextWakeAtMs even when nothing is due", async () => {
  const { store, install } = await setup();
  await store.replaceAlarms(INSTALL_ID, [{ key: "a", triggerAtMs: NOW + 30 * MINUTE }], NOW);
  assert.equal(install().nextWakeAtMs, NOW + 10 * MINUTE);
  await store.replaceAlarms(INSTALL_ID, [], NOW);
  assert.equal(install().nextWakeAtMs, NOW + 20 * MINUTE);
  assert.deepEqual(await store.planAndClaim(INSTALL_ID, [], NOW + MINUTE, "c"), { status: "idle" });
  assert.equal(install().pushClaimId, null);
});

test("disabled installs leave the scheduler queries and resume renewals when re-enabled", async () => {
  const { db, store, install } = await setup();
  const key = "microsoft_abc";
  await store.upsertSubscription(key, {
    installId: INSTALL_ID, provider: "microsoft", verificationHash: sha256Hex("cs"), expiresAtMs: NOW + 2 * 60 * MINUTE,
  }, NOW);
  assert.deepEqual((await store.listRenewalsDue(NOW, 10)).map((subscription) => subscription.key), [key]);

  await store.planAndClaim(INSTALL_ID, [], NOW, "claim");
  await store.disableInstall(INSTALL_ID, "claim", "ab".repeat(32), "apns_unregistered", NOW);
  assert.equal(install().nextWakeAtMs, null);
  assert.deepEqual(await store.listInstallIdsDue(NOW + 24 * 60 * MINUTE, 10), []);

  await store.planAndClaim(INSTALL_ID, [key], NOW, "again");
  assert.equal(db.documents.get(`${COLLECTIONS.subscriptions}/${key}`).renewDueAtMs, null);
  assert.deepEqual(await store.listRenewalsDue(NOW, 10), []);

  await store.updateRegistration(INSTALL_ID, { apnsToken: "cd".repeat(32), apnsEnvironment: "development", heartbeat: HEARTBEAT }, NOW + MINUTE);
  assert.equal(install().enabled, true);
  assert.deepEqual((await store.listRenewalsDue(NOW + MINUTE, 10)).map((subscription) => subscription.key), [key]);
});

test("renewal keys for a deleted install remove the orphaned subscription", async () => {
  const { db, store } = await setup();
  await db.collection(COLLECTIONS.subscriptions).doc("google_orphan").set({
    installId: "MissingInstall00000000", provider: "google", expiresAtMs: NOW + MINUTE, renewDueAtMs: NOW,
  });
  await store.planAndClaim("MissingInstall00000000", ["google_orphan"], NOW, "claim");
  assert.equal(db.documents.has(`${COLLECTIONS.subscriptions}/google_orphan`), false);
});

test("rate limits use hashed keys and fixed windows", async () => {
  const { db, store } = await setup();
  const limits = { limit: 2, windowMs: MINUTE };
  assert.equal(await store.consumeRateLimit("registration:v4:203.0.113.5", limits, NOW), true);
  assert.equal(await store.consumeRateLimit("registration:v4:203.0.113.5", limits, NOW + 1), true);
  assert.equal(await store.consumeRateLimit("registration:v4:203.0.113.5", limits, NOW + 2), false);
  assert.equal(await store.consumeRateLimit("registration:v4:203.0.113.5", limits, NOW + MINUTE), true);
  const paths = [...db.documents.keys()].filter((path) => path.startsWith(COLLECTIONS.rateLimits));
  assert.deepEqual(paths, [`${COLLECTIONS.rateLimits}/${sha256Hex("registration:v4:203.0.113.5")}`]);
});

test("pruning removes expired rate windows and dispatches, week-old subscriptions, and long-disabled installs", async () => {
  const { db, store } = await setup();
  await store.consumeRateLimit("k", { limit: 1, windowMs: MINUTE }, NOW);
  await store.upsertSubscription("google_old", {
    installId: INSTALL_ID, provider: "google", resourceId: "r", verificationHash: sha256Hex("t"), expiresAtMs: NOW + MINUTE,
  }, NOW);
  await store.upsertSubscription("google_live", {
    installId: INSTALL_ID, provider: "google", resourceId: "r", verificationHash: sha256Hex("t"), expiresAtMs: NOW + 60 * MINUTE,
  }, NOW);

  assert.equal(await store.recordWebhookNotifications(INSTALL_ID, { changeProvider: "microsoft" }, NOW, "d1"), "queued");

  // Expired mappings stay a week for late Graph lifecycle events; dispatches an hour.
  assert.deepEqual(await store.pruneExpiredRecords(NOW + MINUTE), { rateLimits: 1, subscriptions: 0, dispatches: 0, installs: 0 });
  assert.equal(db.documents.has(`${COLLECTIONS.subscriptions}/google_old`), true);
  assert.deepEqual(await store.pruneExpiredRecords(NOW + DISPATCH_RETENTION_MS),
    { rateLimits: 0, subscriptions: 0, dispatches: 1, installs: 0 });
  assert.deepEqual(await store.pruneExpiredRecords(NOW + MINUTE + EXPIRED_SUBSCRIPTION_RETENTION_MS),
    { rateLimits: 0, subscriptions: 1, dispatches: 0, installs: 0 });
  assert.equal(db.documents.has(`${COLLECTIONS.subscriptions}/google_old`), false);
  assert.equal(db.documents.has(`${COLLECTIONS.subscriptions}/google_live`), true);
  await store.removeSubscription("google_live", INSTALL_ID);

  await store.planAndClaim(INSTALL_ID, [], NOW + 20 * MINUTE, "claim");
  await store.disableInstall(INSTALL_ID, "claim", "ab".repeat(32), "apns_unregistered", NOW + 20 * MINUTE);
  assert.equal((await store.pruneExpiredRecords(NOW + 21 * MINUTE)).installs, 0);

  // A re-enable that races the prune query wins: the transaction re-checks the install.
  const kept = await store.deleteInstall(INSTALL_ID, { onlyIf: (install) => install.enabled === true });
  assert.equal(kept, false);
  assert.equal(db.documents.has(`${COLLECTIONS.installs}/${INSTALL_ID}`), true);
  const result = await store.pruneExpiredRecords(NOW + 20 * MINUTE + DISABLED_INSTALL_RETENTION_MS);
  assert.equal(result.installs, 1);
  assert.deepEqual([...db.documents.keys()], []);
});

test("webhook notifications are recorded with at most one queued dispatch per burst", async () => {
  const { db, store, install } = await setup();
  const dispatches = () => [...db.documents.keys()].filter((path) => path.startsWith(`${COLLECTIONS.dispatches}/`));
  await store.upsertSubscription("microsoft_a", {
    installId: INSTALL_ID, provider: "microsoft", verificationHash: sha256Hex("c"), expiresAtMs: NOW + 60 * MINUTE,
  }, NOW);

  assert.equal(await store.recordWebhookNotifications(INSTALL_ID, { changeProvider: "microsoft" }, NOW, "d1"), "queued");
  assert.equal(install().pendingChangeAtMs, NOW);
  assert.equal(install().pendingChangeProvider, "microsoft");
  assert.equal(install().nextWakeAtMs, NOW, "the scheduler also sees the work if the dispatch is lost");
  assert.deepEqual(db.documents.get(`${COLLECTIONS.dispatches}/d1`),
    { installId: INSTALL_ID, renewalKeys: [], createdAtMs: NOW, expiresAt: new Date(NOW + DISPATCH_RETENTION_MS) });

  // A second notification while the first dispatch may still be on its way only records work.
  assert.equal(await store.recordWebhookNotifications(INSTALL_ID, { renewalKeys: ["microsoft_a", "microsoft_unknown"] }, NOW + 1000, "d2"), "pending");
  assert.deepEqual(dispatches(), [`${COLLECTIONS.dispatches}/d1`]);
  const subscription = db.documents.get(`${COLLECTIONS.subscriptions}/microsoft_a`);
  assert.equal(subscription.renewalRequestedAtMs, NOW + 1000);
  assert.equal(subscription.renewDueAtMs, NOW + 1000);
  assert.equal(db.documents.has(`${COLLECTIONS.subscriptions}/microsoft_unknown`), false);

  assert.equal(await store.recordWebhookNotifications(INSTALL_ID, { changeProvider: "microsoft" }, NOW + DISPATCH_DEDUPE_MS, "d3"), "queued");
  assert.equal(dispatches().length, 2);

  // While a push is in flight (or coalescing) nothing is queued; the scheduler sends it later.
  const claim = await store.planAndClaim(INSTALL_ID, [], NOW + 2 * DISPATCH_DEDUPE_MS, "claim");
  assert.equal(claim.status, "claimed");
  assert.equal(await store.recordWebhookNotifications(INSTALL_ID, { changeProvider: "microsoft" }, NOW + 3 * DISPATCH_DEDUPE_MS, "d4"), "pending");
  assert.equal(dispatches().length, 2);

  assert.equal(await store.recordWebhookNotifications(INSTALL_ID, { renewalKeys: ["microsoft_unknown"] }, NOW, "d5"), "ignored");
  assert.equal(await store.recordWebhookNotifications("NoSuchInstall000000000", { changeProvider: "microsoft" }, NOW, "d6"), "ignored");
  assert.equal(dispatches().length, 2);
});

test("an expired mapping without a lifecycle request stops being listed for renewal", async () => {
  const { db, store } = await setup();
  await store.upsertSubscription("microsoft_a", {
    installId: INSTALL_ID, provider: "microsoft", verificationHash: sha256Hex("c"), expiresAtMs: NOW + 60 * MINUTE,
  }, NOW);
  // The renewal came due, but every push failed until the mapping expired.
  const later = NOW + 61 * MINUTE;
  assert.deepEqual((await store.listRenewalsDue(later, 10)).map((subscription) => subscription.key), ["microsoft_a"]);
  const claim = await store.planAndClaim(INSTALL_ID, ["microsoft_a"], later, "c");
  assert.notEqual(claim.plan?.kind, "renew");
  assert.equal(db.documents.get(`${COLLECTIONS.subscriptions}/microsoft_a`).renewDueAtMs, null);
  assert.deepEqual(await store.listRenewalsDue(later, 10), []);
});

test("expired mappings kept for late lifecycle events do not count against the subscription limit", async () => {
  const { store } = await setup();
  for (let index = 0; index < 64; index += 1) {
    await store.upsertSubscription(`microsoft_${index}`, {
      installId: INSTALL_ID, provider: "microsoft", verificationHash: sha256Hex("c"), expiresAtMs: NOW + MINUTE,
    }, NOW);
  }
  await assert.rejects(store.upsertSubscription("microsoft_new", {
    installId: INSTALL_ID, provider: "microsoft", verificationHash: sha256Hex("c"), expiresAtMs: NOW + 2 * MINUTE,
  }, NOW), /limit/);
  assert.equal(await store.upsertSubscription("microsoft_new", {
    installId: INSTALL_ID, provider: "microsoft", verificationHash: sha256Hex("c"), expiresAtMs: NOW + 60 * MINUTE,
  }, NOW + MINUTE), "created");
});

test("expired mappings cannot be used to get around the limit or grow storage without bound", async () => {
  const { db, store } = await setup();
  const put = (key, expiresAtMs, nowMs) => store.upsertSubscription(key, {
    installId: INSTALL_ID, provider: "microsoft", verificationHash: sha256Hex("c"), expiresAtMs,
  }, nowMs);
  // Churn: short-lived mappings that expire at once are kept for late lifecycle events...
  for (let index = 0; index < 200; index += 1) await put(`microsoft_churn_${index}`, NOW + index + 1, NOW + index);
  const owned = () => [...db.documents.keys()].filter((path) => path.startsWith(`${COLLECTIONS.subscriptions}/`));
  // ...but never more than the total cap, oldest expired first.
  assert.equal(owned().length, MAX_STORED_SUBSCRIPTIONS_PER_INSTALL);
  assert.equal(db.documents.has(`${COLLECTIONS.subscriptions}/microsoft_churn_0`), false);
  assert.equal(db.documents.has(`${COLLECTIONS.subscriptions}/microsoft_churn_199`), true);

  // With 64 live mappings, re-PUTting an expired one counts as new.
  const later = NOW + 10 * MINUTE;
  for (let index = 0; index < 64; index += 1) await put(`microsoft_live_${index}`, later + 60 * MINUTE, later);
  await assert.rejects(put("microsoft_churn_199", later + 60 * MINUTE, later), /limit/);
  assert.equal(await put("microsoft_live_3", later + 90 * MINUTE, later), "updated", "renewing a live mapping at the limit is fine");
  assert.ok(owned().length <= MAX_STORED_SUBSCRIPTIONS_PER_INSTALL);
});

test("re-enabling an install resumes renewals of live mappings only", async () => {
  const { db, store } = await setup();
  for (const [key, expiresAtMs] of [["microsoft_live", NOW + 3 * 24 * 60 * MINUTE], ["microsoft_gone", NOW + MINUTE]]) {
    await store.upsertSubscription(key, {
      installId: INSTALL_ID, provider: "microsoft", verificationHash: sha256Hex("c"), expiresAtMs,
    }, NOW);
  }
  const claim = await store.planAndClaim(INSTALL_ID, [], NOW + 20 * MINUTE, "claim");
  await store.disableInstall(INSTALL_ID, claim.claimId, "ab".repeat(32), "apns_unregistered", NOW + 20 * MINUTE);
  for (const key of ["microsoft_live", "microsoft_gone"]) {
    await store.planAndClaim(INSTALL_ID, [key], NOW + 21 * MINUTE, "x");
  }
  assert.equal(db.documents.get(`${COLLECTIONS.subscriptions}/microsoft_live`).renewDueAtMs, null, "paused while disabled");
  await store.updateRegistration(INSTALL_ID, { apnsToken: "cd".repeat(32), apnsEnvironment: "development", heartbeat: HEARTBEAT }, NOW + 30 * MINUTE);
  assert.equal(db.documents.get(`${COLLECTIONS.subscriptions}/microsoft_live`).renewDueAtMs, NOW + 2 * 24 * 60 * MINUTE);
  assert.equal(db.documents.get(`${COLLECTIONS.subscriptions}/microsoft_gone`).renewDueAtMs, null);
});

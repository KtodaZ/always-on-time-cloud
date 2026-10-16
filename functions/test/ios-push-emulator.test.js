"use strict";

// Runs the real Firestore store against a local Firestore emulator. Skipped unless
// FIRESTORE_EMULATOR_HOST is set, e.g.:
//   java -jar ~/.cache/firebase/emulators/cloud-firestore-emulator-v*.jar --host 127.0.0.1 --port 8089
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8089 npm test
// The emulator runs offline; nothing here talks to a real project.

const assert = require("node:assert/strict");
const test = require("node:test");

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const skip = emulatorHost ? false : "set FIRESTORE_EMULATOR_HOST to run against the Firestore emulator";

test("Firestore store transactions and queries work against the emulator", { skip }, async () => {
  const { initializeApp, deleteApp } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const { COLLECTIONS, FirestorePushStore, sha256Hex } = require("../ios-push-firestore");

  const app = initializeApp({ projectId: "demo-aot-ios-push" }, `ios-push-emulator-${Date.now()}`);
  const db = getFirestore(app);
  try {
    for (const name of Object.values(COLLECTIONS)) {
      const snapshot = await db.collection(name).get();
      await Promise.all(snapshot.docs.map((document) => document.ref.delete()));
    }
    const store = new FirestorePushStore(db);
    const now = Date.parse("2026-10-07T16:00:00.000Z");
    const installId = "EmulatorInstall0000000";
    const heartbeat = { intervalMinutes: 20, activeHours: { start: "07:00", end: "22:00" }, timeZone: "America/Los_Angeles" };

    assert.equal(await store.registerInstall(installId, {
      installSecretHash: sha256Hex("secret"), apnsToken: "ab".repeat(32), apnsEnvironment: "development", heartbeat,
    }, now), "created");
    assert.equal(await store.authorizeInstall(installId, sha256Hex("secret"), { limit: 5, windowMs: 60_000 }, now), "ok");
    assert.equal(await store.authorizeInstall(installId, sha256Hex("wrong"), { limit: 5, windowMs: 60_000 }, now), "unauthorized");

    await store.replaceAlarms(installId, [{ key: sha256Hex("a"), triggerAtMs: now + 30 * 60_000 }], now);
    await store.upsertSubscription("google_emulator", {
      installId, provider: "google", resourceId: "r", verificationHash: sha256Hex("t"), expiresAtMs: now + 60 * 60_000,
    }, now);

    // Range queries skip null nextWakeAtMs values and order by due time.
    assert.deepEqual(await store.listInstallIdsDue(now + 10 * 60_000, 10), [installId]);
    assert.deepEqual((await store.listRenewalsDue(now, 10)).map((subscription) => subscription.key), ["google_emulator"]);

    const claims = await Promise.all([0, 1, 2].map((index) => store.recordChangeAndClaim(installId, "google", now, `c${index}`)));
    const claimed = claims.filter((claim) => claim.status === "claimed");
    assert.equal(claimed.length, 1, "Firestore transactions allow exactly one concurrent claim");
    assert.equal(await store.completePush(installId, claimed[0].claimId, claimed[0].plan, now), true);

    const renewal = await store.planAndClaim(installId, ["google_emulator"], now + 2 * 60_000, "renew");
    assert.equal(renewal.status, "claimed");
    assert.equal(renewal.plan.kind, "renew");
    await store.completePush(installId, "renew", renewal.plan, now + 2 * 60_000);

    // Graph webhook path: work and the dispatch document commit together; pruning removes it.
    assert.equal(await store.recordWebhookNotifications(installId, { changeProvider: "microsoft" }, now + 4 * 60_000, "dispatch1"), "queued");
    assert.equal((await db.collection(COLLECTIONS.dispatches).doc("dispatch1").get()).data().installId, installId);
    await store.deleteDispatch("dispatch1");
    const change = await store.planAndClaim(installId, [], now + 4 * 60_000, "change");
    assert.equal(change.plan.kind, "change");
    await store.completePush(installId, "change", change.plan, now + 4 * 60_000);
    assert.equal(await store.recordWebhookNotifications(installId, { changeProvider: "microsoft" }, now + 5 * 60_000, "dispatch2"), "pending");
    // A dispatch the trigger never processed is pruned once it expires.
    assert.equal(await store.recordWebhookNotifications(installId, { changeProvider: "microsoft" }, now + 7 * 60_000, "dispatch3"), "queued");
    assert.equal((await store.pruneExpiredRecords(now + 2 * 60 * 60_000)).dispatches, 1);
    assert.equal((await db.collection(COLLECTIONS.dispatches).get()).size, 0);
    assert.deepEqual(await store.listInstallRenewalsDue(installId, now + 7 * 60_000), []);

    await store.planAndClaim(installId, [], now + 4 * 60_000 + 20 * 60_000, "hb");
    await store.disableInstall(installId, "hb", "ab".repeat(32), "apns_unregistered", now + 25 * 60_000);
    assert.deepEqual(await store.listInstallIdsDue(now + 48 * 60 * 60_000, 10), []);

    assert.equal(await store.deleteInstall(installId), true);
    assert.equal((await db.collection(COLLECTIONS.subscriptions).get()).size, 0);
    assert.equal((await db.collection(COLLECTIONS.installs).get()).size, 0);
  } finally {
    await deleteApp(app);
  }
});

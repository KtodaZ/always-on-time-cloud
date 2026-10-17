"use strict";

// Runs the assistant connector's Firestore code against the Firestore emulator (skipped unless
// FIRESTORE_EMULATOR_HOST is set; the Test workflow runs it under `firebase emulators:exec`).

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const skip = emulatorHost ? false : "set FIRESTORE_EMULATOR_HOST to run against the Firestore emulator";

test("connector writes, connections and cleanup work on real Firestore", { skip }, async () => {
  const { initializeApp, deleteApp } = require("firebase-admin/app");
  const { FieldValue, getFirestore } = require("firebase-admin/firestore");
  const { recordChange, refs } = require("../assistant-data");
  const { consume } = require("../assistant-limits");
  const { createOAuth, verifyAccessToken } = require("../assistant-oauth");
  const { createRecordingMessaging } = require("../assistant-push");
  const { createUsage } = require("../assistant-usage");

  const app = initializeApp({ projectId: "demo-account-sync" }, `assistant-emulator-${Date.now()}`);
  const db = getFirestore(app);
  const uid = `emulator-${Date.now()}`;
  try {
    // writtenAt is the same server timestamp as the values' updatedAt, which phones report back.
    const write = (build) => recordChange(db, uid, {
      recordIds: ["p_alarm_volume", "p_max_snoozes"], build, assistant: "Claude", tool: "update_settings", summary: "Changed settings", now: Date.now(),
    });
    const first = await write(() => ({ p_alarm_volume: 70, p_max_snoozes: 3 }));
    const activity = (await refs.activity(db, uid).doc(first.changeId).get()).data();
    const value = await refs.values(db, uid).doc("p_alarm_volume").get();
    assert.equal(activity.writtenAt.isEqual(value.data().updatedAt), true);
    assert.equal((await refs.values(db, uid).doc("p_max_snoozes").get()).data().updatedAt.isEqual(activity.writtenAt), true);
    // The next change is guarded by those update times and wins a race with a phone by retrying.
    let attempts = 0;
    const second = await write(async () => {
      attempts += 1;
      if (attempts === 1) await refs.values(db, uid).doc("p_alarm_volume").set({ payload: "20" });
      return { p_alarm_volume: 90 };
    });
    assert.equal(attempts, 2);
    assert.deepEqual(second.records.p_alarm_volume, { before: "20", after: "90" });

    // A full OAuth connection and revocation, with queries inside transactions.
    await refs.account(db, uid).set({ active: true, schemaVersion: 1 });
    const verifier = "x".repeat(50);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const oauth = createOAuth({
      db, messaging: createRecordingMessaging(), usage: createUsage({ db, increment: (n) => FieldValue.increment(n) }),
      verifyIdToken: async () => ({ uid, firebase: { identities: { "google.com": ["g"] } } }),
      fetchMetadata: async (url) => ({ client_id: url, client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
    });
    const clientId = "https://claude.ai/oauth/mcp-oauth-client-metadata";
    const { redirect } = await oauth.authorize({ response_type: "code", client_id: clientId, code_challenge: challenge, code_challenge_method: "S256" });
    const approved = await oauth.decide({ request: new URL(redirect).searchParams.get("request"), idToken: "x", decision: "approve" });
    const tokens = await oauth.token({ grant_type: "authorization_code", code: new URL(approved.redirect).searchParams.get("code"), code_verifier: verifier, client_id: clientId });
    assert.equal((await verifyAccessToken(db, tokens.access_token)).uid, uid);
    assert.equal((await refs.state(db, uid).get()).data().connections, 1);
    const rotated = await oauth.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
    assert.ok(await verifyAccessToken(db, rotated.access_token));
    await refs.snapshots(db, uid).doc("0f8fad5b-d9cb-469f-a165-70867728950e").set({ schemaVersion: 1, payload: "{}" });
    const [connection] = await oauth.listConnections(uid);
    assert.equal(await oauth.revokeGrant(connection.grantId, { uid }), true);
    assert.equal((await refs.state(db, uid).get()).data().connected, false);
    assert.equal((await refs.snapshots(db, uid).get()).size, 0);
    assert.equal((await refs.activity(db, uid).get()).size, 0);
    assert.equal(await verifyAccessToken(db, rotated.access_token), null);
    assert.equal((await db.collection("oauthTokens").where("grantId", "==", connection.grantId).get()).size, 0);

    // Shared rate limits hold under concurrent use.
    const window = { limit: 3, windowMs: 60_000 };
    const results = await Promise.all(Array.from({ length: 6 }, () => consume(db, `test|${uid}`, window, Date.now())));
    assert.equal(results.filter(Boolean).length, 3);
  } finally {
    await deleteApp(app);
  }
});

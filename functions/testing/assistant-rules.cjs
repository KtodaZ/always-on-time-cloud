// Run with: firebase emulators:exec --only firestore 'node functions/testing/assistant-rules.cjs'
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, getDocs, deleteDoc, collection, serverTimestamp, Timestamp } = require('firebase/firestore');
const fs = require('node:fs');

const DEVICE = '0f8fad5b-d9cb-469f-a165-70867728950e';

(async () => {
  const environment = await initializeTestEnvironment({
    projectId: 'demo-account-sync',
    firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8180 }
  });
  try {
    await environment.clearFirestore();
    const google = uid => environment.authenticatedContext(uid, { firebase: { identities: { 'google.com': [`${uid}-google`] }, sign_in_provider: 'google.com' } }).firestore();
    const alice = google('alice');
    const bob = google('bob');
    const anonymous = environment.authenticatedContext('anon', { firebase: { identities: {}, sign_in_provider: 'anonymous' } }).firestore();
    const admin = async write => environment.withSecurityRulesDisabled(context => write(context.firestore()));
    await admin(db => setDoc(doc(db, 'accounts/alice'), { active: true, schemaVersion: 1 }));
    await admin(db => setDoc(doc(db, 'accounts/bob'), { active: true, schemaVersion: 1 }));

    const device = (extra = {}) => ({
      platform: 'android', deviceName: 'Pixel 9', appVersion: '5.2.0', fcmToken: 'token', capabilities: ['travel', 'pause'],
      updatedAt: serverTimestamp(), ...extra
    });
    const snapshot = (extra = {}) => ({ schemaVersion: 1, publishedAt: serverTimestamp(), payload: '{"events":[]}', ...extra });
    const devicePath = `accounts/alice/assistantDevices/${DEVICE}`;
    const snapshotPath = `accounts/alice/assistantSnapshots/${DEVICE}`;

    // Nothing can be written before an assistant is connected.
    await assertFails(setDoc(doc(alice, devicePath), device()));
    await assertFails(setDoc(doc(alice, snapshotPath), snapshot()));
    await admin(db => setDoc(doc(db, 'accounts/alice/assistant/state'), { connected: false, connections: 0, updatedAt: Timestamp.now() }));
    await assertFails(setDoc(doc(alice, devicePath), device()));

    await admin(db => setDoc(doc(db, 'accounts/alice/assistant/state'), { connected: true, connections: 1, updatedAt: Timestamp.now() }));
    await assertSucceeds(getDoc(doc(alice, 'accounts/alice/assistant/state')));
    await assertFails(getDoc(doc(bob, 'accounts/alice/assistant/state')));
    await assertFails(getDoc(doc(alice, 'accounts/alice/assistant/other')));
    await assertFails(setDoc(doc(alice, 'accounts/alice/assistant/state'), { connected: true, connections: 5, updatedAt: serverTimestamp() }));

    await assertSucceeds(setDoc(doc(alice, devicePath), device()));
    await assertSucceeds(setDoc(doc(alice, devicePath), device({ lastPing: { id: 'ping_abc', receivedAt: Timestamp.fromMillis(Date.now() - 1000) } })));
    // iOS phones have no FCM token yet, and Swift writes UUIDs in upper case.
    const { fcmToken, ...ios } = device({ platform: 'ios' });
    await assertSucceeds(setDoc(doc(alice, `accounts/alice/assistantDevices/${DEVICE.toUpperCase()}`), ios));
    const badDevices = [
      device({ platform: 'windows' }), device({ deviceName: 'x'.repeat(101) }), device({ appVersion: 'x'.repeat(41) }),
      device({ fcmToken: 'x'.repeat(4097) }), device({ capabilities: ['root'] }), device({ capabilities: 'travel' }),
      device({ updatedAt: Timestamp.fromMillis(Date.now() - 60000) }), device({ extra: true }),
      device({ lastPing: { id: 'x'.repeat(65), receivedAt: Timestamp.now() } }), device({ lastPing: { id: 'p' } }),
      (({ deviceName, ...rest }) => rest)(device())
    ];
    for (const bad of badDevices) await assertFails(setDoc(doc(alice, devicePath), bad));
    await assertFails(setDoc(doc(alice, 'accounts/alice/assistantDevices/not-a-uuid'), device()));
    await assertFails(setDoc(doc(bob, `accounts/alice/assistantDevices/${DEVICE}`), device()));
    await assertFails(setDoc(doc(anonymous, `accounts/anon/assistantDevices/${DEVICE}`), device()));
    await assertFails(getDoc(doc(bob, devicePath)));

    await assertSucceeds(setDoc(doc(alice, snapshotPath), snapshot()));
    await assertSucceeds(setDoc(doc(alice, snapshotPath), snapshot({ requestId: 'req_123', payload: 'x'.repeat(800000) })));
    for (const bad of [snapshot({ payload: 'x'.repeat(800001) }), snapshot({ schemaVersion: 2 }), snapshot({ publishedAt: Timestamp.now() }),
      snapshot({ requestId: 'x'.repeat(65) }), snapshot({ payload: {} }), snapshot({ device: 'Pixel' })]) {
      await assertFails(setDoc(doc(alice, snapshotPath), bad));
    }
    await assertSucceeds(getDocs(collection(alice, 'accounts/alice/assistantSnapshots')));
    await assertFails(getDocs(collection(bob, 'accounts/alice/assistantSnapshots')));

    // Activity is server-written; the owner can read it.
    await admin(db => setDoc(doc(db, 'accounts/alice/assistantActivity/ch_1'), { summary: 'x', expiresAt: Timestamp.now() }));
    await assertSucceeds(getDoc(doc(alice, 'accounts/alice/assistantActivity/ch_1')));
    await assertFails(getDoc(doc(bob, 'accounts/alice/assistantActivity/ch_1')));
    await assertFails(setDoc(doc(alice, 'accounts/alice/assistantActivity/ch_2'), { summary: 'forged' }));
    await assertFails(deleteDoc(doc(alice, 'accounts/alice/assistantActivity/ch_1')));

    // Server-only collections have no client access at all.
    for (const path of ['oauthClients/x', 'oauthRequests/x', 'oauthCodes/x', 'oauthGrants/x', 'oauthTokens/x', 'assistantUsage/2026-10-16', 'assistantRateLimits/x']) {
      await assertFails(getDoc(doc(alice, path)));
      await assertFails(setDoc(doc(alice, path), { uid: 'alice' }));
    }

    // When the last assistant disconnects, phones may still delete but no longer write.
    await admin(db => setDoc(doc(db, 'accounts/alice/assistant/state'), { connected: false, connections: 0, updatedAt: Timestamp.now() }));
    await assertFails(setDoc(doc(alice, snapshotPath), snapshot()));
    await assertFails(deleteDoc(doc(bob, snapshotPath)));
    await assertSucceeds(deleteDoc(doc(alice, snapshotPath)));
    await assertSucceeds(deleteDoc(doc(alice, devicePath)));

    // A deleted (tombstoned) account loses access.
    await admin(db => setDoc(doc(db, 'accounts/alice'), { active: false, schemaVersion: 1 }));
    await assertFails(getDoc(doc(alice, 'accounts/alice/assistant/state')));
    console.log('Assistant rules: connection gating, ownership, field validation and server-only collections passed.');
  } finally { await environment.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

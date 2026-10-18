// Run through firebase emulators:exec with Auth, Firestore and account-only Functions enabled.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8180';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9199';
require('firebase-admin/app').initializeApp({ projectId: 'demo-account-sync' });
const db = require('firebase-admin/firestore').getFirestore();
const auth = require('firebase-admin/auth').getAuth();
(async () => {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const subject = randomUUID();
  const token = `${encode({ alg: 'none' })}.${encode({ sub: subject, email: `${subject}@example.test`, email_verified: true, iss: 'https://accounts.google.com', aud: 'test' })}.`;
  const signIn = await fetch('http://127.0.0.1:9199/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestUri: 'http://localhost', postBody: `id_token=${token}&providerId=google.com`, returnSecureToken: true })
  }).then(response => response.json());
  assert.ok(signIn.idToken, JSON.stringify(signIn));
  const root = db.collection('accounts').doc(signIn.localId);
  await root.set({ active: true, schemaVersion: 1 });
  await root.collection('values').doc('p_alarm_volume').set({ payload: '50' });
  await root.collection('history').doc('test-history').set({ payload: '{}', createdAt: Date.now() });
  await root.collection('assistant').doc('state').set({ connected: true, connections: 1 });
  await root.collection('assistant').doc('log').set({ logId: 'log_emulatortest00001', createdAt: new Date() });
  await root.collection('assistantDevices').doc('device').set({ platform: 'android' });
  await root.collection('assistantSnapshots').doc('device').set({ payload: '{}' });
  await root.collection('assistantActivity').doc('ch_test').set({ summary: 'x' });
  await db.collection('oauthGrants').doc(`grant-${subject}`).set({ uid: signIn.localId, clientId: 'client', logId: 'log_emulatortest00001' });
  await db.collection('oauthTokens').doc(`token-${subject}`).set({ uid: signIn.localId, grantId: `grant-${subject}`, kind: 'access' });
  const response = await fetch('http://127.0.0.1:5011/demo-account-sync/us-central1/deleteSyncedAccount', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signIn.idToken}` },
    body: JSON.stringify({ data: {} })
  }).then(response => response.json());
  assert.equal(response.result?.deleted ?? response.data?.deleted, true, JSON.stringify(response));
  assert.deepEqual((await root.get()).data(), { active: false, schemaVersion: 1 }, 'only the marker is left, no longer pending');
  assert.equal((await root.collection('values').get()).size, 0);
  assert.equal((await root.collection('history').get()).size, 0);
  for (const name of ['assistant', 'assistantDevices', 'assistantSnapshots', 'assistantActivity']) {
    assert.equal((await root.collection(name).get()).size, 0, name);
  }
  assert.equal((await db.collection('oauthGrants').doc(`grant-${subject}`).get()).exists, false);
  assert.equal((await db.collection('oauthTokens').doc(`token-${subject}`).get()).exists, false);
  await assert.rejects(auth.getUser(signIn.localId), error => error.code === 'auth/user-not-found');
  assert.equal((await root.collection('assistant').doc('log').get()).exists, false, 'the request-log pseudonym is deleted');
  console.log('PASS: authenticated callable deletes cloud data, assistant connections, the request-log pseudonym and Auth identity, retaining only disabled UID marker.');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });

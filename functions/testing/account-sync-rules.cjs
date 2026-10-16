// Run with: firebase emulators:exec --only firestore 'node functions/testing/account-sync-rules.cjs'
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, getDocs, collection, query, where } = require('firebase/firestore');
const fs = require('node:fs');

(async () => {
  const environment = await initializeTestEnvironment({
    projectId: 'demo-account-sync',
    firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8180 }
  });
  try {
    const alice = environment.authenticatedContext('alice', { firebase: { identities: { 'google.com': ['alice-google'] }, sign_in_provider: 'google.com' } }).firestore();
    const bob = environment.authenticatedContext('bob', { firebase: { identities: { 'google.com': ['bob-google'] }, sign_in_provider: 'google.com' } }).firestore();
    const anonymous = environment.authenticatedContext('anon', { firebase: { identities: {}, sign_in_provider: 'anonymous' } }).firestore();
    await assertSucceeds(setDoc(doc(alice, 'accounts/alice'), { active: true, schemaVersion: 1 }));
    await assertFails(setDoc(doc(anonymous, 'accounts/anon'), { active: true, schemaVersion: 1 }));
    await assertSucceeds(setDoc(doc(alice, 'accounts/alice/values/p_alarm_volume'), { payload: '70' }));
    await assertSucceeds(getDocs(collection(alice, 'accounts/alice/values')));
    await assertFails(getDoc(doc(bob, 'accounts/alice/values/p_alarm_volume')));
    await assertFails(setDoc(doc(bob, 'accounts/alice/values/p_alarm_volume'), { payload: '50' }));
    await assertFails(setDoc(doc(alice, 'accounts/alice/values/p_alarm_volume'), { payload: '70', unexpected: 'private' }));
    await assertFails(setDoc(doc(alice, 'accounts/alice/values/invalid'), { payload: '70' }));
    const record = 'a'.repeat(64);
    await assertSucceeds(setDoc(doc(alice, `accounts/alice/history/${record}`), { payload: '{}', createdAt: Date.now() }));
    await assertFails(setDoc(doc(alice, `accounts/alice/history/${'b'.repeat(64)}`), { payload: '{}', createdAt: Date.now() - 15 * 86400000 }));
    await assertSucceeds(getDocs(query(collection(alice, 'accounts/alice/history'), where('createdAt', '>=', Date.now() - 14 * 86400000))));
    await environment.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'accounts/alice'), { active: false, schemaVersion: 1 });
    });
    await assertFails(setDoc(doc(alice, 'accounts/alice/values/p_alarm_volume'), { payload: '60' }));
    await assertFails(setDoc(doc(alice, 'accounts/alice'), { active: true, schemaVersion: 1 }));
    console.log('Account rules: ownership, anonymous rejection, retention, and deletion tombstone checks passed.');
  } finally { await environment.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

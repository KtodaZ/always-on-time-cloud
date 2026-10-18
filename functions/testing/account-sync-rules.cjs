// Run with: firebase emulators:exec --only firestore 'node functions/testing/account-sync-rules.cjs'
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, getDocs, collection, query, where, serverTimestamp } = require('firebase/firestore');
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
    // Preference records are limited to the app's synced settings; other records are hashed keys.
    for (const name of ['alarms_paused_until', 'override_dnd_for_priority', 'spoken_alarm_speech_rate_hundredths', 'rsvp_filter']) {
      await assertSucceeds(setDoc(doc(alice, `accounts/alice/values/p_${name}`), { payload: 'null' }));
    }
    for (const id of ['p_unknown_setting', `p_${'a'.repeat(400)}`, 'p_alarm_volume_', 'p_', `e_${'a'.repeat(63)}`, `e_${'A'.repeat(64)}`]) {
      await assertFails(setDoc(doc(alice, `accounts/alice/values/${id}`), { payload: '70' }));
    }
    for (const prefix of ['c', 's', 'e']) {
      await assertSucceeds(setDoc(doc(alice, `accounts/alice/values/${prefix}_${'0'.repeat(64)}`), { payload: 'null' }));
    }
    const record = 'a'.repeat(64);
    await assertSucceeds(setDoc(doc(alice, `accounts/alice/history/${record}`), { payload: '{}', createdAt: Date.now() }));
    await assertFails(setDoc(doc(alice, `accounts/alice/history/${'b'.repeat(64)}`), { payload: '{}', createdAt: Date.now() - 15 * 86400000 }));
    await assertSucceeds(getDocs(query(collection(alice, 'accounts/alice/history'), where('createdAt', '>=', Date.now() - 14 * 86400000))));
    await environment.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'accounts/alice'), { active: false, schemaVersion: 1 });
    });
    await assertFails(setDoc(doc(alice, 'accounts/alice/values/p_alarm_volume'), { payload: '60' }));
    await assertFails(setDoc(doc(alice, 'accounts/alice'), { active: true, schemaVersion: 1 }));

    // Feedback: anonymous senders create documents; attachments may omit the download URL.
    const feedback = (attachment) => ({
      message: 'It rang late', contactEmail: 'a@example.com', attachments: attachment ? [attachment] : [],
      createdAt: serverTimestamp(), appVersion: '5.2.0', source: 'android'
    });
    const attachment = (id, extra = {}) => ({ id, path: `feedback/anon/f-${id}/${id}`, contentType: 'image/png', sizeBytes: 4, ...extra });
    await assertSucceeds(setDoc(doc(anonymous, 'feedback/f-a1'), feedback(attachment('a1', { downloadUrl: 'https://example.test/a1' }))));
    await assertSucceeds(setDoc(doc(anonymous, 'feedback/f-a2'), feedback(attachment('a2'))));
    await assertFails(setDoc(doc(anonymous, 'feedback/f-a3'), feedback(attachment('a3', { downloadUrl: '' }))));
    await assertFails(setDoc(doc(anonymous, 'feedback/f-a4'), feedback(attachment('a4', { downloadUrl: 'x'.repeat(2049) }))));
    await assertFails(setDoc(doc(anonymous, 'feedback/f-a5'), feedback(attachment('a5', { downloadUrl: 5 }))));
    await assertFails(setDoc(doc(anonymous, 'feedback/f-a6'), feedback({ ...attachment('a6'), path: 'feedback/other/f-a6/a6' })));
    await assertFails(getDoc(doc(anonymous, 'feedback/f-a1')));
    console.log('Account rules: ownership, preference allowlist, anonymous rejection, retention, deletion tombstone and feedback checks passed.');
  } finally { await environment.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

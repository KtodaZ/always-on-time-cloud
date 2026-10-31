// Run with: firebase emulators:exec --only firestore 'node functions/testing/account-sync-rules.cjs'
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, getDocs, deleteDoc, collection, query, where, serverTimestamp } = require('firebase/firestore');
const assert = require('node:assert/strict');
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
    // Alice's uid without a Google identity (e.g. an anonymous session that kept the uid).
    const aliceWithoutGoogle = environment.authenticatedContext('alice', { firebase: { identities: {}, sign_in_provider: 'anonymous' } }).firestore();
    const signedOut = environment.unauthenticatedContext().firestore();
    // Alice's uid in a password session that has her Google identity (a password account made on
    // her address before she first signed in with Google): refused like a stranger.
    const alicePassword = environment.authenticatedContext('alice', { firebase: { identities: { 'google.com': ['alice-google'], email: ['alice@example.com'] }, sign_in_provider: 'password' } }).firestore();
    await assertSucceeds(setDoc(doc(alice, 'accounts/alice'), { active: true, schemaVersion: 1 }));
    await assertFails(setDoc(doc(anonymous, 'accounts/anon'), { active: true, schemaVersion: 1 }));
    await assertSucceeds(setDoc(doc(alice, 'accounts/alice/values/p_alarm_volume'), { payload: '70' }));
    await assertSucceeds(getDocs(collection(alice, 'accounts/alice/values')));
    await assertFails(getDoc(doc(bob, 'accounts/alice/values/p_alarm_volume')));
    await assertFails(getDoc(doc(alicePassword, 'accounts/alice/values/p_alarm_volume')));
    await assertFails(setDoc(doc(alicePassword, 'accounts/alice/values/p_alarm_volume'), { payload: '50' }));
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
    // Phones delete their own records of ended occurrences (e_) and nothing else.
    const ended = `e_${'1'.repeat(64)}`;
    await assertSucceeds(setDoc(doc(alice, `accounts/alice/values/${ended}`), { payload: '{"leadTimes":[10],"enabled":true}' }));
    await assertFails(deleteDoc(doc(bob, `accounts/alice/values/${ended}`)));
    await assertFails(deleteDoc(doc(aliceWithoutGoogle, `accounts/alice/values/${ended}`)));
    await assertFails(deleteDoc(doc(signedOut, `accounts/alice/values/${ended}`)));
    await assertSucceeds(deleteDoc(doc(alice, `accounts/alice/values/${ended}`)));
    assert.equal((await getDoc(doc(alice, `accounts/alice/values/${ended}`))).exists(), false);
    await assertSucceeds(deleteDoc(doc(alice, `accounts/alice/values/${ended}`)), 'deleting again is harmless');
    for (const id of ['p_alarm_volume', `c_${'0'.repeat(64)}`, `s_${'0'.repeat(64)}`, `e_${'A'.repeat(64)}`, `e_${'1'.repeat(63)}`]) {
      await assertFails(deleteDoc(doc(alice, `accounts/alice/values/${id}`)));
    }
    await assertFails(deleteDoc(doc(alice, 'accounts/alice')));
    const keptForTombstone = `e_${'2'.repeat(64)}`;
    await assertSucceeds(setDoc(doc(alice, `accounts/alice/values/${keptForTombstone}`), { payload: 'null' }));
    const record = 'a'.repeat(64);
    await assertSucceeds(setDoc(doc(alice, `accounts/alice/history/${record}`), { payload: '{}', createdAt: Date.now() }));
    await assertFails(setDoc(doc(alice, `accounts/alice/history/${'b'.repeat(64)}`), { payload: '{}', createdAt: Date.now() - 15 * 86400000 }));
    await assertSucceeds(getDocs(query(collection(alice, 'accounts/alice/history'), where('createdAt', '>=', Date.now() - 14 * 86400000))));
    await environment.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'accounts/alice'), { active: false, schemaVersion: 1 });
    });
    await assertFails(setDoc(doc(alice, 'accounts/alice/values/p_alarm_volume'), { payload: '60' }));
    await assertFails(setDoc(doc(alice, 'accounts/alice'), { active: true, schemaVersion: 1 }));
    // Once deletion has started (or the account is gone), phones can't delete records either.
    await assertFails(deleteDoc(doc(alice, `accounts/alice/values/${keptForTombstone}`)));
    await assertSucceeds(setDoc(doc(bob, 'accounts/bob'), { active: true, schemaVersion: 1 }));
    await environment.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), `accounts/bob/values/${ended}`), { payload: 'null' });
      await setDoc(doc(context.firestore(), `accounts/carol/values/${ended}`), { payload: 'null' });
    });
    const carol = environment.authenticatedContext('carol', { firebase: { identities: { 'google.com': ['carol-google'] }, sign_in_provider: 'google.com' } }).firestore();
    await assertFails(deleteDoc(doc(carol, `accounts/carol/values/${ended}`)), 'no account document');
    await assertSucceeds(deleteDoc(doc(bob, `accounts/bob/values/${ended}`)));

    // Sign in with Apple (iPhone): an Apple-linked account syncs like a Google one, with or
    // without an email (private relay or none); its password session is refused all the same.
    const dana = environment.authenticatedContext('dana', { firebase: { identities: { 'apple.com': ['dana-apple'] }, sign_in_provider: 'apple.com' } }).firestore();
    const danaPassword = environment.authenticatedContext('dana', { firebase: { identities: { 'apple.com': ['dana-apple'], email: ['dana@privaterelay.appleid.com'] }, sign_in_provider: 'password' } }).firestore();
    const danaOtherProvider = environment.authenticatedContext('dana', { firebase: { identities: { 'github.com': ['dana-github'] }, sign_in_provider: 'github.com' } }).firestore();
    await assertFails(setDoc(doc(danaOtherProvider, 'accounts/dana'), { active: true, schemaVersion: 1 }));
    await assertSucceeds(setDoc(doc(dana, 'accounts/dana'), { active: true, schemaVersion: 1 }));
    await assertSucceeds(setDoc(doc(dana, 'accounts/dana/values/p_alarm_volume'), { payload: '70' }));
    await assertSucceeds(getDocs(collection(dana, 'accounts/dana/values')));
    await assertFails(getDoc(doc(danaPassword, 'accounts/dana/values/p_alarm_volume')));
    await assertFails(setDoc(doc(danaPassword, 'accounts/dana/values/p_alarm_volume'), { payload: '50' }));
    await assertFails(getDoc(doc(dana, 'accounts/alice/values/p_alarm_volume')));
    await assertFails(getDoc(doc(alice, 'accounts/dana/values/p_alarm_volume')));

    // Only a Google or Apple session counts (an allowlist, matching the assistant consent check): a
    // session from any other provider is refused even when the account has a Google or Apple
    // identity, and the session's own provider must be linked.
    for (const provider of ['custom', 'anonymous', 'phone', 'github.com']) {
      const other = environment.authenticatedContext('alice', { firebase: { identities: { 'google.com': ['alice-google'] }, sign_in_provider: provider } }).firestore();
      await assertFails(getDoc(doc(other, 'accounts/alice')), provider);
      await assertFails(getDoc(doc(other, 'accounts/bob/values/p_alarm_volume')), provider);
      const otherBob = environment.authenticatedContext('bob', { firebase: { identities: { 'google.com': ['bob-google'], 'apple.com': ['bob-apple'] }, sign_in_provider: provider } }).firestore();
      await assertFails(getDoc(doc(otherBob, 'accounts/bob/values/p_alarm_volume')), provider);
      await assertFails(setDoc(doc(otherBob, 'accounts/bob/values/p_alarm_volume'), { payload: '50' }), provider);
    }
    const bobAppleUnlinked = environment.authenticatedContext('bob', { firebase: { identities: { 'google.com': ['bob-google'] }, sign_in_provider: 'apple.com' } }).firestore();
    await assertFails(getDoc(doc(bobAppleUnlinked, 'accounts/bob/values/p_alarm_volume')));
    const bobBoth = environment.authenticatedContext('bob', { firebase: { identities: { 'google.com': ['bob-google'], 'apple.com': ['bob-apple'] }, sign_in_provider: 'apple.com' } }).firestore();
    await assertSucceeds(getDocs(collection(bobBoth, 'accounts/bob/values')));

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
    // The iOS app writes the same shape with source 'ios'; no other platform value is accepted.
    await assertSucceeds(setDoc(doc(anonymous, 'feedback/f-i1'), { ...feedback(attachment('i1')), source: 'ios', appVersion: '1.0+7' }));
    await assertSucceeds(setDoc(doc(anonymous, 'feedback/f-i2'), {
      ...feedback(), source: 'ios',
      diagnosticLog: { id: 'd2', path: 'feedback/anon/f-i2/d2', contentType: 'text/plain', sizeBytes: 120 }
    }));
    await assertFails(setDoc(doc(anonymous, 'feedback/f-i3'), { ...feedback(), source: 'web' }));
    await assertFails(setDoc(doc(anonymous, 'feedback/f-i4'), { ...feedback(), source: 'iOS' }));
    await assertFails(setDoc(doc(signedOut, 'feedback/f-i5'), { ...feedback(), source: 'ios' }));
    console.log('Account rules: ownership, Apple accounts, provider allowlist, preference allowlist, anonymous rejection, retention, ended-occurrence deletes, deletion tombstone and feedback checks passed.');
  } finally { await environment.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

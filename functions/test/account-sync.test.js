const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore } = require('../testing/fake-firestore');
const {
  isSyncAccount, requireRecentAccount, deleteAccountData, deleteStrayAccount, pruneAccountHistory, resumeAccountDeletions, DELETION_RESUME_AFTER_MS, HISTORY_WINDOW_MS
} = require('../account-sync');

test('deletion requires a Google- or Apple-linked account and recent authentication', () => {
  const now = 1000000;
  const valid = { uid: 'user', token: { auth_time: now / 1000, firebase: { identities: { 'google.com': ['google-id'] }, sign_in_provider: 'google.com' } } };
  assert.equal(requireRecentAccount(valid, now), 'user');
  // Sign in with Apple (iPhone), with a private relay email or none.
  const apple = { uid: 'apple-user', token: { auth_time: now / 1000, firebase: { identities: { 'apple.com': ['apple-id'] }, sign_in_provider: 'apple.com' } } };
  assert.equal(requireRecentAccount(apple, now), 'apple-user');
  assert.throws(() => requireRecentAccount({ ...apple, token: { ...apple.token, auth_time: 0 } }, now), { code: 'failed-precondition' });
  assert.throws(() => requireRecentAccount(null, now), { code: 'unauthenticated' });
  assert.throws(() => requireRecentAccount({ ...valid, token: { ...valid.token, firebase: { identities: {} } } }, now), { code: 'unauthenticated' });
  assert.throws(() => requireRecentAccount({ ...valid, token: { ...valid.token, firebase: { identities: { 'github.com': ['id'] }, sign_in_provider: 'github.com' } } }, now), { code: 'unauthenticated' });
  assert.throws(() => requireRecentAccount({ ...valid, token: { ...valid.token, firebase: { ...valid.token.firebase, sign_in_provider: 'password' } } }, now), { code: 'unauthenticated' });
  assert.throws(() => requireRecentAccount({ ...apple, token: { ...apple.token, firebase: { ...apple.token.firebase, sign_in_provider: 'password' } } }, now), { code: 'unauthenticated' });
  assert.throws(() => requireRecentAccount({ ...valid, token: { ...valid.token, auth_time: 0 } }, now), { code: 'failed-precondition' });
  assert.equal(isSyncAccount(apple), true);
  assert.equal(isSyncAccount({ uid: 'anon', token: { firebase: { identities: {}, sign_in_provider: 'anonymous' } } }), false);
});

test('only a Google or Apple session linked to that provider counts, whatever else the account has', () => {
  const session = (provider, identities) => ({ uid: 'user', token: { auth_time: 1, firebase: { identities, sign_in_provider: provider } } });
  const google = { 'google.com': ['google-id'] };
  // Allowlist, not blocklist: a session from any other provider is refused even with a Google identity.
  for (const provider of ['custom', 'anonymous', 'phone', 'github.com', 'password', undefined]) {
    assert.equal(isSyncAccount(session(provider, google)), false, String(provider));
  }
  // The session's own provider must be linked: an Apple session on a Google-only account is refused.
  assert.equal(isSyncAccount(session('apple.com', google)), false);
  assert.equal(isSyncAccount(session('google.com', { 'apple.com': ['apple-id'] })), false);
  assert.equal(isSyncAccount(session('google.com', google)), true);
  assert.equal(isSyncAccount(session('apple.com', { 'apple.com': ['apple-id'], 'google.com': ['google-id'] })), true);
});

test('deleting reports whether an Always On Time account used the sign-in', async () => {
  const db = new FakeFirestore();
  db.documents.set('accounts/user', { active: true, schemaVersion: 1 });
  const auth = { deleteUser: async () => {} };
  assert.deepEqual(await deleteAccountData(db, auth, 'user'), { hadAccount: true });
  assert.deepEqual(await deleteAccountData(db, auth, 'stray'), { hadAccount: false });
  assert.deepEqual(db.documents.get('accounts/stray'), { active: false, schemaVersion: 1 }, 'a stray sign-in still leaves the marker');
});

test('a stray sign-in is deleted with a marker; an account in use is left alone', async () => {
  const db = new FakeFirestore();
  const now = Date.now();
  db.documents.set('accounts/user', { active: true, schemaVersion: 1 });
  db.documents.set('accounts/user/values/p_alarm_volume', { payload: '50' });
  const deleted = [];
  const auth = { deleteUser: async uid => {
    assert.deepEqual(db.documents.get(`accounts/${uid}`), { active: false, schemaVersion: 1, deletionPending: true, deletionStartedAt: now });
    deleted.push(uid);
  } };
  assert.equal(await deleteStrayAccount(db, auth, 'user', now), false);
  assert.deepEqual(db.documents.get('accounts/user'), { active: true, schemaVersion: 1 });
  assert.deepEqual(db.documents.get('accounts/user/values/p_alarm_volume'), { payload: '50' });
  assert.equal(await deleteStrayAccount(db, auth, 'stray', now), true);
  assert.deepEqual(deleted, ['stray']);
  assert.deepEqual(db.documents.get('accounts/stray'), { active: false, schemaVersion: 1 }, 'no longer pending');
  // A deleted account's marker counts as in use: nothing is deleted twice.
  assert.equal(await deleteStrayAccount(db, auth, 'stray', now), false);
  assert.deepEqual(deleted, ['stray']);
});

test('deletion blocks stale writes, then deletes data, assistant connections and identity', async () => {
  const db = new FakeFirestore();
  const now = Date.now();
  db.documents.set('accounts/user', { active: true, schemaVersion: 1 });
  db.documents.set('accounts/user/values/p_alarm_volume', { payload: '50' });
  db.documents.set('accounts/user/history/h1', { payload: '{}', createdAt: now });
  db.documents.set('accounts/user/assistant/state', { connected: true, connections: 1 });
  // The pseudonym that names the account in request logs must go with it.
  db.documents.set('accounts/user/assistant/log', { logId: 'log_abcdefghijklmnop', createdAt: new Date(now) });
  db.documents.set('accounts/user/assistantDevices/d1', { platform: 'android' });
  db.documents.set('accounts/user/assistantSnapshots/d1', { payload: '{}' });
  db.documents.set('accounts/user/assistantActivity/ch_1', { summary: 'x' });
  db.documents.set('oauthGrants/g1', { uid: 'user', clientId: 'c', logId: 'log_abcdefghijklmnop' });
  db.documents.set('oauthTokens/t1', { grantId: 'g1', uid: 'user' });
  db.documents.set('oauthGrants/g2', { uid: 'someone-else', clientId: 'c' });
  db.documents.set('oauthTokens/t2', { grantId: 'g2', uid: 'someone-else' });
  const deleted = [];
  await deleteAccountData(db, { deleteUser: async uid => {
    // The tombstone and data deletion happen before the identity goes.
    assert.deepEqual(db.documents.get('accounts/user'), { active: false, schemaVersion: 1, deletionPending: true, deletionStartedAt: now });
    assert.deepEqual(Object.keys(db.dump()).sort(), ['accounts/user', 'oauthGrants/g2', 'oauthTokens/t2']);
    deleted.push(uid);
  } }, 'user', now);
  assert.deepEqual(deleted, ['user']);
  assert.deepEqual(Object.keys(db.dump()).sort(), ['accounts/user', 'oauthGrants/g2', 'oauthTokens/t2']);
  assert.deepEqual(db.documents.get('accounts/user'), { active: false, schemaVersion: 1 }, 'no longer pending');
  assert.ok(!JSON.stringify(db.dump()).includes('log_abcdefghijklmnop'), 'no copy of the logId survives');
});

test('history pruning uses fourteen-day cutoff and batches until empty', async () => {
  const deleted = []; let pages = 0;
  const query = {
    where: (field, operation, cutoff) => {
      assert.equal(field, 'createdAt'); assert.equal(operation, '<'); assert.equal(cutoff, 2000000000 - HISTORY_WINDOW_MS); return query;
    },
    limit: size => { assert.equal(size, 400); return query; },
    get: async () => pages++ ? { empty: true } : { empty: false, size: 2, docs: [{ ref: 'a' }, { ref: 'b' }] }
  };
  const db = { collectionGroup: name => { assert.equal(name, 'history'); return query; },
    batch: () => ({ delete: ref => deleted.push(ref), commit: async () => {} }) };
  assert.equal(await pruneAccountHistory(db, 2000000000), 2);
  assert.deepEqual(deleted, ['a', 'b']);
});

test('deletion revokes assistant access before deleting synced data', async () => {
  const db = new FakeFirestore();
  db.documents.set('accounts/user', { active: true, schemaVersion: 1 });
  db.documents.set('accounts/user/values/p_alarm_volume', { payload: '50' });
  db.documents.set('oauthGrants/g1', { uid: 'user', clientId: 'c' });
  db.documents.set('oauthTokens/t1', { grantId: 'g1', uid: 'user' });
  const recursiveDelete = db.recursiveDelete.bind(db);
  db.recursiveDelete = async ref => {
    if (ref.path === 'accounts/user/values') {
      assert.equal(db.documents.has('oauthGrants/g1'), false, 'grants go first');
      assert.equal(db.documents.has('oauthTokens/t1'), false, 'tokens go first');
    }
    return recursiveDelete(ref);
  };
  await deleteAccountData(db, { deleteUser: async () => {} }, 'user');
  assert.equal(db.documents.has('accounts/user/values/p_alarm_volume'), false);
});

test('a deletion that stopped partway is finished later, and an already deleted identity is fine', async () => {
  const db = new FakeFirestore();
  const now = 5000000000;
  db.documents.set('accounts/stopped', { active: false, schemaVersion: 1, deletionPending: true, deletionStartedAt: now - DELETION_RESUME_AFTER_MS - 1 });
  db.documents.set('accounts/stopped/history/h1', { payload: '{}', createdAt: now });
  db.documents.set('accounts/stopped/assistant/log', { logId: 'log_x' });
  db.documents.set('oauthGrants/g1', { uid: 'stopped', clientId: 'c' });
  // Still running in its callable: left alone for now.
  db.documents.set('accounts/running', { active: false, schemaVersion: 1, deletionPending: true, deletionStartedAt: now - 1000 });
  db.documents.set('accounts/running/values/p_alarm_volume', { payload: '50' });
  db.documents.set('accounts/done', { active: false, schemaVersion: 1 });
  const deleted = [];
  const auth = { deleteUser: async uid => {
    deleted.push(uid);
    throw Object.assign(new Error('gone'), { code: 'auth/user-not-found' });
  } };
  assert.equal(await resumeAccountDeletions(db, auth, now), 1);
  assert.deepEqual(deleted, ['stopped']);
  assert.deepEqual(db.documents.get('accounts/stopped'), { active: false, schemaVersion: 1 });
  assert.equal(db.documents.has('accounts/stopped/history/h1'), false);
  assert.equal(db.documents.has('accounts/stopped/assistant/log'), false);
  assert.equal(db.documents.has('oauthGrants/g1'), false);
  assert.ok(db.documents.has('accounts/running/values/p_alarm_volume'));
  assert.equal(await resumeAccountDeletions(db, auth, now + DELETION_RESUME_AFTER_MS), 1);
  assert.equal(db.documents.has('accounts/running/values/p_alarm_volume'), false);
  // Other Auth errors leave the account pending for the next run.
  db.documents.set('accounts/flaky', { active: false, schemaVersion: 1, deletionPending: true, deletionStartedAt: 0 });
  await assert.rejects(resumeAccountDeletions(db, { deleteUser: async () => { throw new Error('unavailable'); } }, now), /unavailable/);
  assert.equal(db.documents.get('accounts/flaky').deletionPending, true);
});

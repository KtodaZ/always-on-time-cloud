const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore } = require('../testing/fake-firestore');
const { requireRecentGoogleAccount, deleteAccountData, pruneAccountHistory, HISTORY_WINDOW_MS } = require('../account-sync');

test('deletion requires a Google-linked account and recent authentication', () => {
  const now = 1000000;
  const valid = { uid: 'user', token: { auth_time: now / 1000, firebase: { identities: { 'google.com': ['google-id'] } } } };
  assert.equal(requireRecentGoogleAccount(valid, now), 'user');
  assert.throws(() => requireRecentGoogleAccount(null, now), { code: 'unauthenticated' });
  assert.throws(() => requireRecentGoogleAccount({ ...valid, token: { ...valid.token, firebase: { identities: {} } } }, now), { code: 'unauthenticated' });
  assert.throws(() => requireRecentGoogleAccount({ ...valid, token: { ...valid.token, auth_time: 0 } }, now), { code: 'failed-precondition' });
});

test('deletion blocks stale writes, then deletes data, assistant connections and identity', async () => {
  const db = new FakeFirestore();
  const now = Date.now();
  db.documents.set('accounts/user', { active: true, schemaVersion: 1 });
  db.documents.set('accounts/user/values/p_alarm_volume', { payload: '50' });
  db.documents.set('accounts/user/history/h1', { payload: '{}', createdAt: now });
  db.documents.set('accounts/user/assistant/state', { connected: true, connections: 1 });
  db.documents.set('accounts/user/assistantDevices/d1', { platform: 'android' });
  db.documents.set('accounts/user/assistantSnapshots/d1', { payload: '{}' });
  db.documents.set('accounts/user/assistantActivity/ch_1', { summary: 'x' });
  db.documents.set('oauthGrants/g1', { uid: 'user', clientId: 'c' });
  db.documents.set('oauthTokens/t1', { grantId: 'g1', uid: 'user' });
  db.documents.set('oauthGrants/g2', { uid: 'someone-else', clientId: 'c' });
  db.documents.set('oauthTokens/t2', { grantId: 'g2', uid: 'someone-else' });
  const deleted = [];
  await deleteAccountData(db, { deleteUser: async uid => {
    // The tombstone and data deletion happen before the identity goes.
    assert.deepEqual(db.documents.get('accounts/user'), { active: false, schemaVersion: 1 });
    deleted.push(uid);
  } }, 'user');
  assert.deepEqual(deleted, ['user']);
  assert.deepEqual(Object.keys(db.dump()).sort(), ['accounts/user', 'oauthGrants/g2', 'oauthTokens/t2']);
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

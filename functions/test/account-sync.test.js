const test = require('node:test');
const assert = require('node:assert/strict');
const { requireRecentGoogleAccount, deleteAccountData, pruneAccountHistory, HISTORY_WINDOW_MS } = require('../account-sync');

test('deletion requires a Google-linked account and recent authentication', () => {
  const now = 1000000;
  const valid = { uid: 'user', token: { auth_time: now / 1000, firebase: { identities: { 'google.com': ['google-id'] } } } };
  assert.equal(requireRecentGoogleAccount(valid, now), 'user');
  assert.throws(() => requireRecentGoogleAccount(null, now), { code: 'unauthenticated' });
  assert.throws(() => requireRecentGoogleAccount({ ...valid, token: { ...valid.token, firebase: { identities: {} } } }, now), { code: 'unauthenticated' });
  assert.throws(() => requireRecentGoogleAccount({ ...valid, token: { ...valid.token, auth_time: 0 } }, now), { code: 'failed-precondition' });
});

test('deletion blocks stale writes before deleting data and identity', async () => {
  const calls = [];
  const root = { set: async value => calls.push(['block', value]), collection: name => name };
  await deleteAccountData({ collection: () => ({ doc: () => root }), recursiveDelete: async collection => calls.push(['delete', collection]) },
    { deleteUser: async uid => calls.push(['auth', uid]) }, 'user');
  assert.deepEqual(calls, [['block', { active: false, schemaVersion: 1 }], ['delete', 'values'], ['delete', 'history'], ['auth', 'user']]);
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

const { deleteConnectorData } = require('./assistant-data');
const { deleteAllGrants } = require('./assistant-oauth');

const HISTORY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function requireRecentGoogleAccount(auth, now = Date.now()) {
  if (!auth || !auth.token?.firebase?.identities?.['google.com']?.length) {
    const error = new Error('Sign in with Google before deleting your account.');
    error.code = 'unauthenticated';
    throw error;
  }
  if (!Number.isFinite(auth.token.auth_time) || now / 1000 - auth.token.auth_time > 300) {
    const error = new Error('Sign in again before deleting your account.');
    error.code = 'failed-precondition';
    throw error;
  }
  return auth.uid;
}

async function deleteAccountData(db, auth, uid) {
  const root = db.collection('accounts').doc(uid);
  // Keep a minimal UID tombstone so an already-issued token cannot recreate deleted data.
  await root.set({ active: false, schemaVersion: 1 });
  await db.recursiveDelete(root.collection('values'));
  await db.recursiveDelete(root.collection('history'));
  // Assistant connections: revoke every grant, then remove what the connector stored.
  await deleteAllGrants(db, uid);
  await deleteConnectorData(db, uid);
  // assistant/state and assistant/log: removing the logId leaves the connector's request logs
  // (which name the account only by it) with nothing that ties them to this account.
  await db.recursiveDelete(root.collection('assistant'));
  await auth.deleteUser(uid);
}

async function pruneAccountHistory(db, now = Date.now()) {
  const cutoff = now - HISTORY_WINDOW_MS;
  let deleted = 0;
  for (;;) {
    const page = await db.collectionGroup('history').where('createdAt', '<', cutoff).limit(400).get();
    if (page.empty) return deleted;
    const batch = db.batch();
    page.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    deleted += page.size;
  }
}

module.exports = { HISTORY_WINDOW_MS, requireRecentGoogleAccount, deleteAccountData, pruneAccountHistory };

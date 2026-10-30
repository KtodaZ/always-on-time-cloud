const { deleteConnectorData } = require('./assistant-data');
const { deleteAllGrants } = require('./assistant-oauth');

const HISTORY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

// Account sync signs in with Google (Android and iPhone) or Sign in with Apple (iPhone only).
const ACCOUNT_PROVIDERS = ['google.com', 'apple.com'];

/**
 * Whether a session belongs to an account-sync account: linked to Google or Apple, and not a password
 * session (firestore.rules isSyncAccount explains why). An Apple account may have a private relay
 * email or none, so nothing here depends on the email.
 */
function isSyncAccount(auth) {
  const identities = auth?.token?.firebase?.identities;
  return Boolean(auth) && ACCOUNT_PROVIDERS.some((provider) => identities?.[provider]?.length > 0)
    && auth.token.firebase.sign_in_provider !== 'password';
}

function requireRecentAccount(auth, now = Date.now()) {
  if (!isSyncAccount(auth)) {
    const error = new Error('Sign in before deleting your account.');
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

// A deletion still marked pending this long after it started has stopped (the callable's timeout is
// shorter), so resumeAccountDeletions finishes it.
const DELETION_RESUME_AFTER_MS = 15 * 60 * 1000;
const RESUME_BATCH = 20;

async function deleteAccountData(db, auth, uid, now = Date.now()) {
  const root = db.collection('accounts').doc(uid);
  // Keep a minimal UID tombstone so an already-issued token cannot recreate deleted data. It stays
  // marked pending until everything below is gone, so a deletion that stops partway is resumed.
  await root.set({ active: false, schemaVersion: 1, deletionPending: true, deletionStartedAt: now });
  await finishAccountDeletion(db, auth, uid);
}

/** Deletes everything a (tombstoned) account left behind. Safe to run again after a partial run. */
async function finishAccountDeletion(db, auth, uid) {
  const root = db.collection('accounts').doc(uid);
  // Assistant connections first: revoke every grant and token so no assistant can act on the
  // account while the rest is deleted, then remove what the connector stored.
  await deleteAllGrants(db, uid);
  await deleteConnectorData(db, uid);
  await db.recursiveDelete(root.collection('values'));
  await db.recursiveDelete(root.collection('history'));
  // assistant/state and assistant/log: removing the logId leaves the connector's request logs
  // (which name the account only by it) with nothing that ties them to this account.
  await db.recursiveDelete(root.collection('assistant'));
  try {
    await auth.deleteUser(uid);
  } catch (error) {
    if (error?.code !== 'auth/user-not-found') throw error;
  }
  await root.set({ active: false, schemaVersion: 1 });
}

/** Finishes deletions that stopped partway (a timeout or crash). Returns how many it finished. */
async function resumeAccountDeletions(db, auth, now = Date.now()) {
  const page = await db.collection('accounts').where('deletionPending', '==', true).limit(RESUME_BATCH).get();
  let resumed = 0;
  for (const doc of page.docs) {
    const started = doc.data().deletionStartedAt;
    if (Number.isFinite(started) && started > now - DELETION_RESUME_AFTER_MS) continue;
    await finishAccountDeletion(db, auth, doc.id);
    resumed += 1;
  }
  return resumed;
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

module.exports = {
  DELETION_RESUME_AFTER_MS, HISTORY_WINDOW_MS, isSyncAccount, requireRecentAccount, deleteAccountData, finishAccountDeletion,
  pruneAccountHistory, resumeAccountDeletions,
};

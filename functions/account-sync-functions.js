const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { requireRecentAccount, deleteAccountData, deleteStrayAccount, pruneAccountHistory, resumeAccountDeletions } = require('./account-sync');

// Large accounts take a while to delete. If a call still runs out of time, the account stays marked
// pending and resumeAccountDeletions finishes it. Returns {deleted, hadAccount}; hadAccount is false
// when no Always On Time account used the sign-in. With {onlyIfUnused: true} (the delete page, right
// after a sign-in) it deletes the sign-in only when no account uses it, and otherwise changes nothing.
exports.deleteSyncedAccount = onCall({ region: 'us-central1', maxInstances: 1, timeoutSeconds: 540 }, async request => {
  let uid;
  try { uid = requireRecentAccount(request.auth); }
  catch (error) { throw new HttpsError(error.code, error.message); }
  if (request.data?.onlyIfUnused === true) {
    const deleted = await deleteStrayAccount(getFirestore(), getAuth(), uid);
    return { deleted, hadAccount: !deleted };
  }
  const { hadAccount } = await deleteAccountData(getFirestore(), getAuth(), uid);
  return { deleted: true, hadAccount };
});

exports.pruneSyncedHistory = onSchedule({ schedule: 'every 24 hours', region: 'us-central1', maxInstances: 1 },
  () => pruneAccountHistory(getFirestore()));

exports.resumeAccountDeletions = onSchedule({ schedule: 'every 1 hours', region: 'us-central1', maxInstances: 1, timeoutSeconds: 540 },
  () => resumeAccountDeletions(getFirestore(), getAuth()));

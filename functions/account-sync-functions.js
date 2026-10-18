const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { requireRecentGoogleAccount, deleteAccountData, pruneAccountHistory, resumeAccountDeletions } = require('./account-sync');

// Large accounts take a while to delete. If a call still runs out of time, the account stays marked
// pending and resumeAccountDeletions finishes it.
exports.deleteSyncedAccount = onCall({ region: 'us-central1', maxInstances: 1, timeoutSeconds: 540 }, async request => {
  let uid;
  try { uid = requireRecentGoogleAccount(request.auth); }
  catch (error) { throw new HttpsError(error.code, error.message); }
  await deleteAccountData(getFirestore(), getAuth(), uid);
  return { deleted: true };
});

exports.pruneSyncedHistory = onSchedule({ schedule: 'every 24 hours', region: 'us-central1', maxInstances: 1 },
  () => pruneAccountHistory(getFirestore()));

exports.resumeAccountDeletions = onSchedule({ schedule: 'every 1 hours', region: 'us-central1', maxInstances: 1, timeoutSeconds: 540 },
  () => resumeAccountDeletions(getFirestore(), getAuth()));

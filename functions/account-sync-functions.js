const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { requireRecentGoogleAccount, deleteAccountData, pruneAccountHistory } = require('./account-sync');

exports.deleteSyncedAccount = onCall({ region: 'us-central1', maxInstances: 1 }, async request => {
  let uid;
  try { uid = requireRecentGoogleAccount(request.auth); }
  catch (error) { throw new HttpsError(error.code, error.message); }
  await deleteAccountData(getFirestore(), getAuth(), uid);
  return { deleted: true };
});

exports.pruneSyncedHistory = onSchedule({ schedule: 'every 24 hours', region: 'us-central1', maxInstances: 1 },
  () => pruneAccountHistory(getFirestore()));

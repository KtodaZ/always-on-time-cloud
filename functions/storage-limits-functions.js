"use strict";

// Triggers that keep per-account and feedback storage bounded (storage-limits.js).

const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { logger } = require("firebase-functions");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");

const {
  capAssistantDevices, capAssistantSnapshots, capHistory, deleteOrphanFeedbackUploads,
} = require("./storage-limits");

const REGION = "us-central1";

/** A trigger on a newly created account document that trims its collection back to the cap. */
function capOnCreate(document, cap) {
  return onDocumentCreated({ document, region: REGION, maxInstances: 10, retry: false }, async (event) => {
    const deleted = await cap(getFirestore(), event.params.uid);
    if (deleted) logger.info("Trimmed account storage to its cap", { collection: document.split("/")[2], deleted });
  });
}

exports.capSyncedHistory = capOnCreate("accounts/{uid}/history/{recordId}", capHistory);
exports.capAssistantDevices = capOnCreate("accounts/{uid}/assistantDevices/{deviceId}", capAssistantDevices);
exports.capAssistantSnapshots = capOnCreate("accounts/{uid}/assistantSnapshots/{deviceId}", capAssistantSnapshots);

exports.deleteOrphanFeedbackUploads = onSchedule({ schedule: "every 6 hours", region: REGION, maxInstances: 1, timeoutSeconds: 540 }, async () => {
  const result = await deleteOrphanFeedbackUploads(getFirestore(), getStorage().bucket());
  logger.info("Checked feedback uploads", result);
});

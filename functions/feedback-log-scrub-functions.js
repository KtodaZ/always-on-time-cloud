"use strict";

// Storage trigger that scrubs feedback diagnostics files after upload (feedback-log-scrub.js).

const { getStorage } = require("firebase-admin/storage");
const { logger } = require("firebase-functions");
const { onObjectFinalized } = require("firebase-functions/v2/storage");

const { scrubFeedbackDiagnosticObject } = require("./feedback-log-scrub");

// The project's default bucket, where the app uploads feedback attachments.
const FEEDBACK_BUCKET = "always-on-time-zombit-2026.firebasestorage.app";

exports.scrubFeedbackDiagnostics = onObjectFinalized(
  { bucket: FEEDBACK_BUCKET, region: "us-central1", maxInstances: 2, memory: "512MiB", timeoutSeconds: 120, retry: false },
  async (event) => {
    const object = event.data;
    try {
      const result = await scrubFeedbackDiagnosticObject(object, getStorage().bucket(object.bucket), logger);
      if (result.status !== "skipped") logger.info("Checked a feedback diagnostics file", { status: result.status });
    } catch (error) {
      // A precondition failure means the file changed while it was read; its new generation
      // triggers this function again.
      logger.error("Could not scrub a feedback diagnostics file", {
        code: error?.code, errorType: error?.name,
      });
    }
  },
);

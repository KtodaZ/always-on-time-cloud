const { initializeApp } = require("firebase-admin/app");
const { logger } = require("firebase-functions");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");

const { buildFeedbackNotification } = require("./feedback-notification");

initializeApp();

// iOS relay push service: device registration API, provider webhooks, and the push scheduler.
Object.assign(exports, require("./ios-push-functions"));
Object.assign(exports, require("./account-sync-functions"));
Object.assign(exports, require("./travel-route-functions"));

// ntfy.sh topics are readable by anyone who knows the name, so the topic URL is an unguessable
// secret rather than a constant in this public repository.
const feedbackNtfyUrl = defineSecret("FEEDBACK_NTFY_URL");

exports.publishFeedbackNotification = onDocumentCreated(
  {
    document: "feedback/{feedbackId}",
    region: "us-central1",
    maxInstances: 1,
    retry: true,
    secrets: [feedbackNtfyUrl],
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
      logger.warn("Feedback-created event did not include a document", {
        feedbackId: event.params.feedbackId,
      });
      return;
    }

    const feedbackId = event.params.feedbackId;
    const feedback = snapshot.data();
    if (typeof feedback.message !== "string" || feedback.message.trim().length === 0) {
      logger.warn("Ignoring feedback event without a message", { feedbackId });
      return;
    }

    try {
      const notification = buildFeedbackNotification(feedback, feedbackId);
      const response = await fetch(feedbackNtfyUrl.value(), {
        method: "POST",
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Title": notification.title,
          "X-Priority": "default",
          "X-Tags": "speech_balloon",
          "X-Click": notification.click,
        },
        body: notification.body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const retryAfter = response.headers.get("retry-after");
        const retryHint = retryAfter ? `; Retry-After: ${retryAfter}` : "";
        throw new Error(`ntfy returned HTTP ${response.status}${retryHint}`);
      }

      logger.info("Published feedback notification", {
        feedbackId,
        ntfyStatus: response.status,
      });
    } catch (error) {
      logger.error("Could not publish feedback notification", { feedbackId, error });
      throw error;
    }
  },
);

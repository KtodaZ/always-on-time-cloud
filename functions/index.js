const { initializeApp } = require("firebase-admin/app");
const { logger } = require("firebase-functions");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");

const { buildFeedbackNotification, discordPayload } = require("./feedback-notification");

initializeApp();

// iOS relay push service: device registration API, provider webhooks, and the push scheduler.
Object.assign(exports, require("./ios-push-functions"));
Object.assign(exports, require("./account-sync-functions"));
Object.assign(exports, require("./travel-route-functions"));

// A Discord webhook URL can post to the developer's private channel but not read it. It is still a
// secret so nobody else can post alerts.
const feedbackWebhookUrl = defineSecret("FEEDBACK_DISCORD_WEBHOOK_URL");

exports.publishFeedbackNotification = onDocumentCreated(
  {
    document: "feedback/{feedbackId}",
    region: "us-central1",
    maxInstances: 1,
    retry: true,
    secrets: [feedbackWebhookUrl],
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
      const response = await fetch(feedbackWebhookUrl.value(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(discordPayload(notification)),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const retryAfter = response.headers.get("retry-after");
        const retryHint = retryAfter ? `; Retry-After: ${retryAfter}` : "";
        throw new Error(`Discord returned HTTP ${response.status}${retryHint}`);
      }

      logger.info("Published feedback notification", {
        feedbackId,
        status: response.status,
      });
    } catch (error) {
      logger.error("Could not publish feedback notification", { feedbackId, error });
      throw error;
    }
  },
);

"use strict";

// Firebase wiring for the iOS relay push service. Credentials come only from Firebase params and
// Secret Manager at runtime; nothing here reads or contains real keys.

const { getAppCheck } = require("firebase-admin/app-check");
const { getFirestore } = require("firebase-admin/firestore");
const { logger } = require("firebase-functions");
const { defineBoolean } = require("firebase-functions/params");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");

const { apnsAuthKey, getApnsTransport } = require("./apns-config");
const { createApnsSender } = require("./ios-push-apns");
const { COLLECTIONS, FirestorePushStore } = require("./ios-push-firestore");
const { createIosPushService } = require("./ios-push-service");

const REGION = "us-central1";
const SCHEDULE_BUDGET_MS = 50 * 1000;

const enforceAppCheck = defineBoolean("IOS_PUSH_ENFORCE_APP_CHECK", {
  default: true,
  description: "Require a Firebase App Check token for iOS install registration",
});

let service;
let sender;

function getSender() {
  if (!sender) {
    sender = createApnsSender({ transport: getApnsTransport() });
  }
  return sender;
}

function getService() {
  if (!service) {
    service = createIosPushService({
      store: new FirestorePushStore(getFirestore()),
      verifyAppCheck: async (token) => {
        await getAppCheck().verifyToken(token);
        return true;
      },
      enforceAppCheck: () => enforceAppCheck.value(),
      sendPush: (request) => getSender()(request),
      logger,
    });
  }
  return service;
}

const httpOptions = { region: REGION, invoker: "public", maxInstances: 10, timeoutSeconds: 30 };

exports.iosPushApi = onRequest(httpOptions, (req, res) => getService().apiHandler(req, res));

exports.iosGoogleWebhook = onRequest(
  { ...httpOptions, secrets: [apnsAuthKey] },
  (req, res) => getService().googleWebhookHandler(req, res),
);

// Graph expects an answer within about 3 seconds and Cloud Run may throttle CPU once a response
// is sent, so this webhook only records the work and never calls APNs (no APNs secret).
exports.iosMicrosoftWebhook = onRequest(httpOptions, (req, res) => getService().microsoftWebhookHandler(req, res));

// Sends the push the Graph webhook queued. Not retried: the install record keeps the pending
// work and the scheduler picks it up within a minute if this fails.
exports.deliverIosPushDispatch = onDocumentCreated(
  {
    document: `${COLLECTIONS.dispatches}/{dispatchId}`,
    region: REGION,
    maxInstances: 10,
    timeoutSeconds: 60,
    retry: false,
    secrets: [apnsAuthKey],
  },
  async (event) => {
    const outcome = await getService().deliverDispatch(event.params.dispatchId, event.data?.data() ?? null);
    logger.info("iOS push dispatch", { outcome });
  },
);

exports.scheduleIosPushes = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "Etc/UTC",
    region: REGION,
    maxInstances: 1,
    timeoutSeconds: 120,
    retryCount: 0,
    secrets: [apnsAuthKey],
  },
  async () => {
    const counts = await getService().scheduledPushes({ deadlineMs: Date.now() + SCHEDULE_BUDGET_MS });
    logger.info("iOS push scheduler pass", counts);
  },
);

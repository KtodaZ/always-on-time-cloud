"use strict";

// Firebase wiring for the assistant connector (docs/ASSISTANT_CONNECTOR.md). Hosting rewrites
// /mcp, /oauth/** and /.well-known/oauth-* on https://always-on-time-zombit-2026.web.app here.

const { getAuth } = require("firebase-admin/auth");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { logger } = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
const { HttpsError, onCall, onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");

const { createMcpHandler, loadSdk } = require("./assistant-mcp");
const { PRODUCTION_ORIGIN, createOAuth } = require("./assistant-oauth");
const { createOAuthHandler } = require("./assistant-oauth-http");
const { createRecordingMessaging } = require("./assistant-push");
const { createUsage, weeklySummary } = require("./assistant-usage");
const { discordPayload } = require("./feedback-notification");

const REGION = "us-central1";
const feedbackWebhookUrl = defineSecret("FEEDBACK_DISCORD_WEBHOOK_URL");

const emulated = process.env.FUNCTIONS_EMULATOR === "true";
// Local testing through the Hosting emulator can point the issuer at it; production never reads this.
const origin = emulated && process.env.ASSISTANT_ORIGIN ? process.env.ASSISTANT_ORIGIN : PRODUCTION_ORIGIN;

let shared;
function services() {
  if (!shared) {
    const db = getFirestore();
    // The emulators cannot deliver FCM messages; record them in memory instead.
    const messaging = emulated ? createRecordingMessaging() : getMessaging();
    const usage = createUsage({ db, increment: (amount) => FieldValue.increment(amount), logger });
    const oauth = createOAuth({
      db,
      origin,
      messaging,
      logger,
      usage,
      verifyIdToken: (token) => getAuth().verifyIdToken(token, true),
    });
    shared = { db, messaging, usage, oauth };
  }
  return shared;
}

/** Google account emails of a user, for turning Google calendar ids into record keys. */
async function accountEmails(uid) {
  const user = await getAuth().getUser(uid);
  return [user.email, ...user.providerData.filter((provider) => provider.providerId === "google.com").map((provider) => provider.email)]
    .filter(Boolean);
}

let mcpHandler;
let oauthHandler;

exports.assistantMcp = onRequest(
  { region: REGION, invoker: "public", maxInstances: 10, timeoutSeconds: 60, memory: "512MiB" },
  (req, res) => {
    if (!mcpHandler) {
      const { db, messaging, usage } = services();
      mcpHandler = createMcpHandler({
        db, messaging, usage, logger, origin, accountEmails, sdk: loadSdk(),
        fields: { serverTimestamp: () => FieldValue.serverTimestamp() },
      });
    }
    return mcpHandler(req, res);
  },
);

exports.assistantOauth = onRequest(
  { region: REGION, invoker: "public", maxInstances: 10, timeoutSeconds: 30, memory: "256MiB" },
  (req, res) => {
    if (!oauthHandler) {
      const { db, oauth, usage } = services();
      oauthHandler = createOAuthHandler({ oauth, db, logger, usage });
    }
    return oauthHandler(req, res);
  },
);

/** Callable from the app: same requirement as account sync, a Google-linked active account. */
async function requireActiveAccount(request) {
  const auth = request.auth;
  if (!auth || !auth.token?.firebase?.identities?.["google.com"]?.length) {
    throw new HttpsError("unauthenticated", "Sign in with Google first.");
  }
  const account = await getFirestore().collection("accounts").doc(auth.uid).get();
  if (!account.exists || account.data().active !== true) throw new HttpsError("failed-precondition", "Account sync is not set up.");
  return auth.uid;
}

exports.listAssistantConnections = onCall({ region: REGION, maxInstances: 5 }, async (request) => {
  const uid = await requireActiveAccount(request);
  return { connections: await services().oauth.listConnections(uid) };
});

exports.revokeAssistantConnection = onCall({ region: REGION, maxInstances: 5 }, async (request) => {
  const uid = await requireActiveAccount(request);
  const grantId = request.data?.grantId;
  if (typeof grantId !== "string" || grantId.length === 0 || grantId.length > 100) {
    throw new HttpsError("invalid-argument", "grantId is required.");
  }
  return { revoked: await services().oauth.revokeGrant(grantId, { reason: "app", uid }) };
});

exports.pruneAssistantConnections = onSchedule(
  { schedule: "every 24 hours", region: REGION, maxInstances: 1, timeoutSeconds: 300 },
  async () => {
    const revoked = await services().oauth.pruneIdleGrants();
    logger.info("Pruned idle assistant connections", { revoked });
  },
);

// Monday morning summary of last week's anonymous connector totals for the developer's channel.
exports.sendAssistantUsageSummary = onSchedule(
  { schedule: "every monday 09:00", timeZone: "Etc/UTC", region: REGION, maxInstances: 1, retryCount: 0, secrets: [feedbackWebhookUrl] },
  async () => {
    const summary = await weeklySummary(getFirestore(), Date.now());
    const response = await fetch(feedbackWebhookUrl.value(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(discordPayload({
        title: "Always On Time assistants: weekly usage",
        body: summary,
        click: "https://console.firebase.google.com/project/always-on-time-zombit-2026/firestore/databases/-default-/data/~2FassistantUsage",
      })),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Discord returned HTTP ${response.status}`);
  },
);

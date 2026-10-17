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

const { LIMITS, consume } = require("./assistant-limits");
const { errorFields, logEvent } = require("./assistant-log");
const { createMcpHandler, loadSdk } = require("./assistant-mcp");
const { ToolError } = require("./assistant-snapshot");
const { TOOLS } = require("./assistant-tools");
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
  const connections = await services().oauth.listConnections(uid);
  logEvent(logger, "info", "callable.list_connections", { uid, count: connections.length });
  return { connections };
});

exports.revokeAssistantConnection = onCall({ region: REGION, maxInstances: 5 }, async (request) => {
  const uid = await requireActiveAccount(request);
  const grantId = request.data?.grantId;
  if (typeof grantId !== "string" || grantId.length === 0 || grantId.length > 100) {
    throw new HttpsError("invalid-argument", "grantId is required.");
  }
  const revoked = await services().oauth.revokeGrant(grantId, { reason: "app", uid });
  logEvent(logger, "info", "callable.revoke_connection", { uid, grantId, revoked });
  return { revoked };
});

/** Undo from the app's activity log; the same checks as the assistant's undo tool. */
exports.undoAssistantChange = onCall({ region: REGION, maxInstances: 5 }, async (request) => {
  const uid = await requireActiveAccount(request);
  const changeId = request.data?.changeId;
  if (typeof changeId !== "string" || !/^ch_[A-Za-z0-9_-]{16}$/.test(changeId)) {
    throw new HttpsError("invalid-argument", "changeId is required.");
  }
  const { db, messaging, usage } = services();
  const counts = {};
  const started = Date.now();
  const trace = {};
  const ctx = {
    db,
    uid,
    grant: { grantId: `app|${uid}`, clientName: "Always On Time app", assistant: "app", scopes: ["alarms.read", "alarms.write"] },
    origin,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    messaging,
    logger,
    pushAllowed: () => consume(db, `push|app|${uid}`, LIMITS.push, Date.now()),
    count: (name, amount = 1) => { counts[name] = (counts[name] ?? 0) + amount; },
    trace,
  };
  const done = (outcome, extra = {}) => logEvent(logger, outcome === "unexpected_error" ? "error" : "info", "callable.undo", {
    uid, outcome, durationMs: Date.now() - started, ...trace, ...extra,
  });
  try {
    const out = await TOOLS.find((tool) => tool.name === "undo").handler(ctx, { changeId });
    if (Object.keys(counts).length) await usage(counts).catch(() => {});
    done("ok");
    return { undone: out.data?.changed === true, changeId: out.data?.changeId ?? null, message: out.text };
  } catch (error) {
    if (error instanceof ToolError) {
      done("tool_error");
      throw new HttpsError("failed-precondition", error.message);
    }
    done("unexpected_error", errorFields(error));
    throw error;
  }
});

exports.pruneAssistantConnections = onSchedule(
  { schedule: "every 24 hours", region: REGION, maxInstances: 1, timeoutSeconds: 300 },
  async () => {
    const revoked = await services().oauth.pruneIdleGrants();
    logEvent(logger, "info", "prune", { revoked });
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

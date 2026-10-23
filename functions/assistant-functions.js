"use strict";

// Firebase wiring for the assistant connector (docs/ASSISTANT_CONNECTOR.md). Hosting rewrites
// /mcp, /oauth/** and /.well-known/oauth-* on https://alwaysontime.zombit.io here. Hosting serves the
// same paths on the project's default domains, whose requests are pointed at the custom domain.

const { getAuth } = require("firebase-admin/auth");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { logger } = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
const { HttpsError, onCall, onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");

const { apnsAuthKey, getApnsTransport } = require("./apns-config");
const { isChangeId, readLogId, refs } = require("./assistant-data");
const { errorFields, logEvent } = require("./assistant-log");
const { createMcpHandler, loadSdk } = require("./assistant-mcp");
const { ToolError } = require("./assistant-snapshot");
const { createToolContext } = require("./assistant-tool-context");
const { TOOLS } = require("./assistant-tools");
const { LEGACY_HOSTS, PRODUCTION_ORIGIN, createOAuth } = require("./assistant-oauth");
const { createOAuthHandler } = require("./assistant-oauth-http");
const { createRecordingApns, createRecordingMessaging } = require("./assistant-push");
const { createUsage, weeklySummary } = require("./assistant-usage");
const { discordPayload } = require("./feedback-notification");

const REGION = "us-central1";
const feedbackWebhookUrl = defineSecret("FEEDBACK_DISCORD_WEBHOOK_URL");

const emulated = process.env.FUNCTIONS_EMULATOR === "true";
// Local testing through the Hosting emulator can point the issuer at it; production never reads this.
const origin = emulated && process.env.ASSISTANT_ORIGIN ? process.env.ASSISTANT_ORIGIN : PRODUCTION_ORIGIN;
// The emulators serve on localhost only, so nothing there needs to move.
const legacyHosts = emulated ? [] : LEGACY_HOSTS;

let shared;
function services() {
  if (!shared) {
    const db = getFirestore();
    // The emulators cannot deliver FCM or APNs pushes; record them in memory instead.
    const messaging = emulated ? createRecordingMessaging() : getMessaging();
    // The transport is created on first use, so functions without the APNs secret never read it
    // (their iPhone pushes fail as apns:unconfigured; only `state` is sent from those, and iPhones
    // skip it). In the emulator, APNs pushes are also written to emulatorApnsPushes for
    // testing/assistant-e2e.cjs.
    const apns = emulated
      ? createRecordingApns({ onSend: (request) => db.collection("emulatorApnsPushes").add({ token: request.token, payload: request.body, at: new Date() }) })
      : { send: (request) => getApnsTransport().send(request) };
    const usage = createUsage({ db, increment: (amount) => FieldValue.increment(amount), logger });
    const oauth = createOAuth({
      db,
      origin,
      messaging,
      apns,
      logger,
      usage,
      verifyIdToken: (token) => getAuth().verifyIdToken(token, true),
    });
    shared = { db, messaging, apns, usage, oauth };
  }
  return shared;
}

/** Google account emails of a user, for turning Google calendar ids into record keys (failures are logged by the caller). */
async function accountEmails(uid) {
  const user = await getAuth().getUser(uid);
  return [user.email, ...user.providerData.filter((provider) => provider.providerId === "google.com").map((provider) => provider.email)]
    .filter(Boolean);
}

let mcpHandler;
let oauthHandler;

// The APNs key is bound only to the functions that can push a change, ping or publish request to
// an iPhone: the MCP endpoint and the app's undo. The others send only `state`, which iPhones skip.
exports.assistantMcp = onRequest(
  { region: REGION, invoker: "public", maxInstances: 10, timeoutSeconds: 60, memory: "512MiB", secrets: [apnsAuthKey] },
  (req, res) => {
    if (!mcpHandler) {
      const { db, messaging, apns, usage } = services();
      mcpHandler = createMcpHandler({
        db, messaging, apns, usage, logger, origin, legacyHosts, accountEmails, sdk: loadSdk(),
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
      oauthHandler = createOAuthHandler({ oauth, db, logger, usage, legacyHosts });
    }
    return oauthHandler(req, res);
  },
);

/**
 * Callable from the app: same requirement as account sync, a Google-linked active account. Returns
 * the uid and the account's logId (null before its first assistant connection), read alongside the
 * account document, for the log line.
 */
async function requireActiveAccount(request) {
  const auth = request.auth;
  if (!auth || !auth.token?.firebase?.identities?.["google.com"]?.length) {
    throw new HttpsError("unauthenticated", "Sign in with Google first.");
  }
  const db = getFirestore();
  const [account, logId] = await Promise.all([refs.account(db, auth.uid).get(), readLogId(db, auth.uid)]);
  if (!account.exists || account.data().active !== true) throw new HttpsError("failed-precondition", "Account sync is not set up.");
  return { uid: auth.uid, logId };
}

/**
 * Runs a callable. An unexpected error is logged here (its message scrubbed of account ids) and
 * reaches the app as a plain internal error, so the Functions runtime doesn't log it raw.
 */
function connectorCallable(event, handler, options = {}) {
  return onCall({ region: REGION, maxInstances: 5, ...options }, async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      logEvent(logger, "error", event, { outcome: "unexpected_error", ...errorFields(error) });
      throw new HttpsError("internal", "Something went wrong on the Always On Time server. Try again in a moment.");
    }
  });
}

exports.listAssistantConnections = connectorCallable("callable.list_connections", async (request) => {
  const { uid, logId } = await requireActiveAccount(request);
  const connections = await services().oauth.listConnections(uid);
  logEvent(logger, "info", "callable.list_connections", { logId, count: connections.length });
  return { connections };
});

exports.revokeAssistantConnection = connectorCallable("callable.revoke_connection", async (request) => {
  const { uid, logId } = await requireActiveAccount(request);
  const grantId = request.data?.grantId;
  if (typeof grantId !== "string" || grantId.length === 0 || grantId.length > 100) {
    throw new HttpsError("invalid-argument", "grantId is required.");
  }
  const revoked = await services().oauth.revokeGrant(grantId, { reason: "app", uid });
  logEvent(logger, "info", "callable.revoke_connection", { logId, grantId, revoked });
  return { revoked };
});

/** Undo from the app's activity log; the same checks as the assistant's undo tool. */
exports.undoAssistantChange = connectorCallable("callable.undo", async (request) => {
  const { uid, logId } = await requireActiveAccount(request);
  const changeId = request.data?.changeId;
  if (!isChangeId(changeId)) throw new HttpsError("invalid-argument", "changeId is required.");
  const { db, messaging, apns, usage } = services();
  const started = Date.now();
  const ctx = createToolContext({
    db,
    uid,
    // grantId keys this account's push allowance (stored hashed); it is never logged.
    grant: { grantId: `app|${uid}`, clientName: "Always On Time app", assistant: "app", scopes: ["alarms.read", "alarms.write"] },
    logId,
    origin,
    now: () => Date.now(),
    messaging,
    apns,
    logger,
  });
  const done = (outcome, extra = {}) => logEvent(logger, outcome === "unexpected_error" ? "error" : "info", "callable.undo", {
    logId, outcome, durationMs: Date.now() - started, ...ctx.trace, ...extra,
  });
  try {
    // Failures after the commit (reaching the phones) are already folded into the message.
    const out = await TOOLS.find((tool) => tool.name === "undo").handler(ctx, { changeId });
    await usage(ctx.counts);
    done("ok");
    return { undone: out.data?.changed === true, changeId: out.data?.changeId ?? null, message: out.text };
  } catch (error) {
    if (error instanceof ToolError) {
      done("tool_error");
      throw new HttpsError("failed-precondition", error.message);
    }
    done("unexpected_error", errorFields(error));
    throw new HttpsError("internal", "Something went wrong on the Always On Time server. Try again in a moment.");
  }
}, { secrets: [apnsAuthKey] });

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

"use strict";

// What every assistant tool runs with (createToolContext, used by the MCP server and the app's
// undo callable alike) and the helpers tools share: reading snapshots, sending FCM hints, and
// saving a change (applyChange). Every Firestore path is derived from ctx.uid, the uid of the
// verified access token or callable caller.

const { LIMITS, consume } = require("./assistant-limits");
const { COLLECTIONS, readDevices, readSnapshots, recordChange } = require("./assistant-data");
const { deliveryFields, errorFields, logEvent } = require("./assistant-log");
const { deviceName, sendToDevices } = require("./assistant-push");
const { RecordError } = require("./assistant-records");
const { changeAlert } = require("./assistant-settings");
const { ToolError, appLink, normalizeSnapshot } = require("./assistant-snapshot");

const POLL_MS = 1500;

/**
 * `deps`: db, uid, grant ({grantId, logId, clientName, assistant, scopes, setupConfirmedAt}), logId
 * (when the grant has none), origin, now, sleep, messaging, logger, accountEmails(uid). Usage counts
 * and the debugging trace for one call collect on the context (ctx.counts, ctx.trace). Log lines
 * name the account by ctx.logId, never ctx.uid (assistant-log.js).
 */
function createToolContext(deps) {
  const { db, uid, grant, now, logger } = deps;
  const counts = {};
  const ctx = {
    db,
    uid,
    logId: grant.logId ?? deps.logId ?? null,
    grant,
    origin: deps.origin,
    now,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    messaging: deps.messaging,
    logger,
    counts,
    trace: {},
    count: (name, amount = 1) => {
      counts[name] = (counts[name] ?? 0) + amount;
    },
    accountEmails: () => (deps.accountEmails ? deps.accountEmails(uid) : []),
    pushAllowed: () => consume(db, `push|${grant.grantId}`, LIMITS.push, now()),
    confirmSetup: async () => {
      grant.setupConfirmedAt = now();
      await db.collection(COLLECTIONS.grants).doc(grant.grantId).update({ setupConfirmedAt: new Date(grant.setupConfirmedAt) });
    },
  };
  return ctx;
}

function result(text, data = {}) {
  return { text, data };
}

/** Ids and outcomes for this call's debugging log line (assistant-log.js). */
const trace = (ctx, fields) => Object.assign(ctx.trace, fields);

async function loadSnapshots(ctx) {
  const snapshots = (await readSnapshots(ctx.db, ctx.uid)).filter((item) => item.payload && item.publishedAt);
  return snapshots.map(normalizeSnapshot);
}

/** The newest snapshot, or null. */
async function latestSnapshot(ctx) {
  return (await loadSnapshots(ctx))[0] ?? null;
}

function noPhone(ctx) {
  const link = appLink(ctx.origin, "assistants");
  return result(
    `No phone has shared its alarms yet. Ask the user to open Always On Time on their phone, signed in with the same Google account; it finishes connecting automatically. Then try again. Link: ${link}`,
    { needsPhone: true, links: { assistants: link } },
  );
}

async function requireSnapshot(ctx) {
  const snapshot = await latestSnapshot(ctx);
  if (!snapshot) throw Object.assign(new Error("no snapshot"), { noPhone: true });
  return snapshot;
}

/** The account's Google emails, for Google calendar ids; without them only keys and names resolve. */
async function accountEmails(ctx) {
  try {
    return await ctx.accountEmails();
  } catch (error) {
    logEvent(ctx.logger, "warn", "account_emails_failed", { logId: ctx.logId, ...errorFields(error) });
    return [];
  }
}

const hasCapability = (devices, capability) => devices.some((device) => Array.isArray(device.capabilities) && device.capabilities.includes(capability));
/** `plus` means the phone has Plus benefits: subscribed, or Plus is free while the paywall is off. */
const hasPlus = (devices) => hasCapability(devices, "plus");

/** Sends an FCM hint unless this connection has used up its push allowance. */
async function push(ctx, type, data, devices) {
  let sent;
  if (!(await ctx.pushAllowed())) {
    ctx.count("rateLimited");
    sent = { limited: true, sent: [], failed: [], removed: [], errors: {}, noToken: devices ?? [] };
  } else {
    sent = await sendToDevices({ db: ctx.db, messaging: ctx.messaging, logger: ctx.logger, logId: ctx.logId }, ctx.uid, type, data, devices);
  }
  trace(ctx, { push: deliveryFields(type, sent) });
  return sent;
}

const names = (devices) => devices.map(deviceName).join(", ");

async function sleepUntil(ctx, deadline, check) {
  for (;;) {
    const done = await check();
    if (done) return done;
    if (ctx.now() + POLL_MS > deadline) return null;
    await ctx.sleep(POLL_MS);
  }
}

/**
 * Saves a change (validated, canonical, logged for undo with its alert) and nudges the phones.
 * Once the commit succeeds the change stands: failing to reach the phones afterwards only changes
 * the note, never the result.
 */
async function applyChange(ctx, { recordIds, build, tool, summary, afterWrite }) {
  let saved;
  try {
    saved = await recordChange(ctx.db, ctx.uid, {
      recordIds, build, assistant: ctx.grant.clientName, tool, summary, now: ctx.now(), afterWrite, alert: changeAlert,
    });
  } catch (error) {
    if (error instanceof RecordError) throw new ToolError(`That setting can't be saved: ${error.message}.`);
    throw error;
  }
  const { changeId, records, alert } = saved;
  if (!changeId) {
    trace(ctx, { status: "unchanged" });
    return result("That is already how it's set; nothing changed.", { changed: false });
  }
  trace(ctx, { changeId, recordIds: Object.keys(records), status: "changed" });
  ctx.count("changes");
  let delivery;
  let sentTo = [];
  try {
    const devices = await readDevices(ctx.db, ctx.uid);
    const sent = await push(ctx, "sync", { changeId }, devices);
    sentTo = sent.sent.map(deviceName);
    if (sent.sent.length) delivery = `Sent to ${names(sent.sent)}; call confirm_change with this changeId to check the phone applied it.`;
    else if (!devices.length) delivery = "No phone is connected yet; the change applies when Always On Time next syncs on the user's phone.";
    else delivery = "The phone couldn't be reached right now; it applies the change the next time Always On Time syncs (opening the app does it).";
  } catch (error) {
    logEvent(ctx.logger, "warn", "push.after_commit_failed", { logId: ctx.logId, changeId, type: "sync", ...errorFields(error) });
    trace(ctx, { status: "changed_not_notified" });
    delivery = "The phone couldn't be notified right now; it applies the change the next time Always On Time syncs (opening the app does it).";
  }
  return result(`${summary}. Saved as change ${changeId}. ${delivery} It can be reversed with undo.`, {
    changed: true, changeId, records: Object.keys(records), sentTo, ...(alert ? { alert } : {}),
  });
}

module.exports = {
  accountEmails,
  applyChange,
  createToolContext,
  hasCapability,
  hasPlus,
  latestSnapshot,
  loadSnapshots,
  names,
  noPhone,
  push,
  requireSnapshot,
  result,
  sleepUntil,
  trace,
};

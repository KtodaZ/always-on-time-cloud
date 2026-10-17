"use strict";

// Anonymous daily usage totals for the assistant connector: assistantUsage/{yyyy-mm-dd} holds only
// counters (no user ids, no content). Each event is a single merged increment write.

const { COLLECTIONS } = require("./assistant-data");

const ASSISTANTS = ["claude", "chatgpt", "other"];

const DAY_MS = 24 * 60 * 60 * 1000;
const day = (now) => new Date(now).toISOString().slice(0, 10);

/** The UTC date of the Monday that starts `now`'s week, as yyyy-mm-dd. */
const week = (now) => day(now - ((new Date(now).getUTCDay() + 6) % 7) * DAY_MS);

/** Turns {"tools.get_status": 1, "errors.get_status": 1} into nested increments for a merge write. */
function nest(counts, increment) {
  const out = {};
  for (const [path, amount] of Object.entries(counts)) {
    if (!amount) continue;
    const parts = path.split(".");
    if (parts.some((part) => !/^[A-Za-z0-9_]{1,40}$/.test(part))) throw new Error(`invalid usage counter ${path}`);
    let node = out;
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)] = increment(amount);
  }
  return out;
}

function createUsage({ db, increment, now = Date.now, logger }) {
  return async (counts) => {
    const update = nest(counts, increment);
    if (Object.keys(update).length === 0) return;
    try {
      await db.collection(COLLECTIONS.usage).doc(day(now())).set(update, { merge: true });
    } catch (error) {
      // Counting must never break the request it counts.
      logger?.warn?.("Assistant usage counter write failed", { name: error?.name });
    }
  };
}

const sum = (map) => Object.values(map ?? {}).reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);

/** Adds daily totals documents together. */
function combineDays(days) {
  const total = {};
  const add = (target, source) => {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (typeof value === "number") target[key] = (target[key] ?? 0) + value;
      else if (value && typeof value === "object") add(target[key] ??= {}, value);
    }
  };
  for (const data of days) add(total, data);
  return total;
}

const number = (value) => Math.round(value).toLocaleString("en-US");
const percent = (part, whole) => `${Math.round((100 * part) / whole)}%`;

/**
 * One-paragraph weekly summary from daily totals, for the developer's private channel. Uses only
 * the anonymous counters, e.g. "Assistants this week: 42 connected (31 Claude, 11 ChatGPT), ...".
 */
function formatWeeklySummary(days) {
  const total = combineDays(days);
  // weeklyActive counts each connection once, on its first call of the UTC Monday-based week, so
  // seven days that make up one such week add up to distinct connections.
  const active = total.weeklyActive ?? {};
  const connected = sum(active);
  const byAssistant = ASSISTANTS.filter((name) => active[name])
    .map((name) => `${number(active[name])} ${name === "claude" ? "Claude" : name === "chatgpt" ? "ChatGPT" : "other"}`);
  const parts = [`${number(connected)} connected${byAssistant.length ? ` (${byAssistant.join(", ")})` : ""}`];
  const newConnections = sum(total.connectionsNew);
  const disconnects = sum(total.disconnects);
  if (newConnections || disconnects) parts.push(`${number(newConnections)} new, ${number(disconnects)} disconnected`);
  const calls = sum(total.tools);
  parts.push(`${number(calls)} tool calls`);
  const errors = sum(total.errors);
  if (calls) parts.push(`${percent(errors, calls)} errors`);
  const slow = sum(total.slow);
  if (slow) parts.push(`${number(slow)} slow`);
  const setup = total.setupTests ?? {};
  const setupRuns = sum(setup);
  if (setupRuns) parts.push(`setup test ${percent(setup.received ?? 0, setupRuns)} ok`);
  const confirms = total.confirms ?? {};
  const confirmRuns = sum(confirms);
  if (confirmRuns) parts.push(`${percent(confirms.confirmed ?? 0, confirmRuns)} of confirmations applied`);
  const changes = total.changes ?? 0;
  if (changes) parts.push(`${percent(total.undos ?? 0, changes)} of changes undone`);
  parts.push(`${number(total.plusGate ?? 0)} Plus-gate replies`);
  if (total.rateLimited) parts.push(`${number(total.rateLimited)} rate-limited`);
  return `Assistants this week: ${parts.join(", ")}.`;
}

/** Reads the seven daily documents before `now` (UTC days) and formats them. Run it on Mondays. */
async function weeklySummary(db, now) {
  const ids = Array.from({ length: 7 }, (_, index) => day(now - (index + 1) * DAY_MS));
  const docs = await Promise.all(ids.map((id) => db.collection(COLLECTIONS.usage).doc(id).get()));
  return formatWeeklySummary(docs.filter((doc) => doc.exists).map((doc) => doc.data()));
}

module.exports = { ASSISTANTS, combineDays, createUsage, day, formatWeeklySummary, nest, week, weeklySummary };

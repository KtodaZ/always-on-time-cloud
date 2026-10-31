// The developer alert says only that feedback arrived. The message, contact email, screenshots and
// diagnostics stay in Firestore and Storage, so nothing a user wrote passes through the alert service.

const FIRESTORE_CONSOLE_DATA_URL =
  "https://console.firebase.google.com/project/always-on-time-zombit-2026/firestore/databases/-default-/data/";

// Alerts per UTC hour. Past it, one alert says more feedback is arriving and the rest wait in
// Firestore; the next hour's first alert says how many arrived without one.
const ALERTS_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;
// Delivery is retried after server errors, but never for an event older than this.
const MAX_EVENT_AGE_MS = HOUR_MS;
// The `source` values firestore.rules accepts.
const PLATFORMS = new Map([["android", "Android"], ["ios", "iPhone"]]);

function buildFeedbackNotification(feedback, feedbackId, { missedLastHour = 0 } = {}) {
  const details = [
    `v${safeVersion(feedback.appVersion)}`,
    PLATFORMS.get(feedback.source) ?? "unknown platform",
  ];
  const attachmentCount = Array.isArray(feedback.attachments) ? Math.min(feedback.attachments.length, 3) : 0;
  if (attachmentCount > 0) {
    details.push(`${attachmentCount} screenshot${attachmentCount === 1 ? "" : "s"}`);
  }
  if (feedback.diagnosticLog) details.push("diagnostics attached");
  if (missedLastHour > 0) details.push(`${missedLastHour} more last hour without an alert`);

  return {
    title: "New Always On Time feedback",
    body: details.join(" · "),
    // The console requires the developer's sign-in, so the link exposes nothing on its own.
    click: `${FIRESTORE_CONSOLE_DATA_URL}~2Ffeedback~2F${encodeURIComponent(feedbackId)}`,
  };
}

/** Discord webhook body. Mentions are disabled so an alert can never ping anyone. */
function discordPayload(notification) {
  return {
    username: "Always On Time",
    allowed_mentions: { parse: [] },
    embeds: [{
      title: notification.title,
      description: notification.body,
      url: notification.click,
      color: 0x2f80ed,
    }],
  };
}

/** The alert sent once an hour's alerts are used up, instead of one per feedback. */
function buildOverflowNotification(now) {
  const resumes = new Date(now - (now % HOUR_MS) + HOUR_MS).toISOString().slice(11, 16);
  return {
    title: "More Always On Time feedback",
    body: `Feedback is arriving quickly, so alerts are paused until ${resumes} UTC. Every message is in Firestore.`,
    click: `${FIRESTORE_CONSOLE_DATA_URL}~2Ffeedback`,
  };
}

/**
 * Which alert this feedback gets, from its position in the hour (`count`, this one included)
 * and last hour's total: a "single" alert, the hour's one "summary", or "none".
 */
function planAlert({ count, previousCount = 0, cap = ALERTS_PER_HOUR }) {
  if (count > cap + 1) return { kind: "none" };
  if (count === cap + 1) return { kind: "summary" };
  return { kind: "single", missedLastHour: count === 1 ? Math.max(0, previousCount - cap) : 0 };
}

const hourId = (now) => new Date(now - (now % HOUR_MS)).toISOString().slice(0, 13);

/** Counts this feedback in its hour (feedbackAlerts/{yyyy-mm-ddThh}); returns {count, previousCount}. */
async function countAlert(db, now) {
  const ref = db.collection("feedbackAlerts").doc(hourId(now));
  const previousRef = db.collection("feedbackAlerts").doc(hourId(now - HOUR_MS));
  return db.runTransaction(async (transaction) => {
    const [doc, previous] = await Promise.all([transaction.get(ref), transaction.get(previousRef)]);
    const count = (doc.exists ? doc.data().count ?? 0 : 0) + 1;
    // expiresAt lets a Firestore TTL policy drop old hours.
    transaction.set(ref, { count, expiresAt: new Date(now + 2 * HOUR_MS) });
    return { count, previousCount: previous.exists ? previous.data().count ?? 0 : 0 };
  });
}

/**
 * Sends the developer alert for one feedback document. A 4xx from Discord (429 included) is
 * final: it is logged and the event is not retried. Server and network errors throw so the
 * trigger retries, but only while the event is under MAX_EVENT_AGE_MS old.
 */
async function publishFeedbackAlert({ feedback, feedbackId, eventTime, db, webhookUrl, fetchImpl = fetch, logger, now = Date.now() }) {
  const age = now - Date.parse(eventTime ?? "");
  if (Number.isFinite(age) && age > MAX_EVENT_AGE_MS) {
    logger.warn("Dropping a feedback alert retried for too long", { feedbackId });
    return "expired";
  }
  const plan = planAlert(await countAlert(db, now));
  if (plan.kind === "none") {
    logger.info("Feedback alert skipped; this hour's alerts are used up", { feedbackId });
    return "skipped";
  }
  const notification = plan.kind === "summary"
    ? buildOverflowNotification(now)
    : buildFeedbackNotification(feedback, feedbackId, { missedLastHour: plan.missedLastHour });
  const response = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(discordPayload(notification)),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status >= 400 && response.status < 500) {
    logger.error("Discord refused the feedback alert; not retrying", {
      feedbackId, status: response.status, retryAfter: response.headers?.get?.("retry-after") ?? null,
    });
    return "refused";
  }
  if (!response.ok) throw new Error(`Discord returned HTTP ${response.status}`);
  logger.info("Published feedback notification", { feedbackId, status: response.status, kind: plan.kind });
  return plan.kind;
}

/** appVersion is client-supplied, so only a short version-like string is echoed. */
function safeVersion(value) {
  return typeof value === "string" && /^[0-9A-Za-z._+-]{1,40}$/.test(value) ? value : "unknown";
}

module.exports = {
  ALERTS_PER_HOUR, MAX_EVENT_AGE_MS, buildFeedbackNotification, buildOverflowNotification, discordPayload, planAlert, publishFeedbackAlert,
};

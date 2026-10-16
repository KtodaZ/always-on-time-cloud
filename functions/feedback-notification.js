// The developer alert says only that feedback arrived. The message, contact email, screenshots and
// diagnostics stay in Firestore and Storage, so nothing a user wrote passes through ntfy.

const FIRESTORE_CONSOLE_DATA_URL =
  "https://console.firebase.google.com/project/always-on-time-zombit-2026/firestore/databases/-default-/data/";

function buildFeedbackNotification(feedback, feedbackId) {
  const details = [
    `v${safeVersion(feedback.appVersion)}`,
    feedback.source === "android" ? "Android" : "unknown platform",
  ];
  const attachmentCount = Array.isArray(feedback.attachments) ? Math.min(feedback.attachments.length, 3) : 0;
  if (attachmentCount > 0) {
    details.push(`${attachmentCount} screenshot${attachmentCount === 1 ? "" : "s"}`);
  }
  if (feedback.diagnosticLog) details.push("diagnostics attached");

  return {
    title: "New Always On Time feedback",
    body: details.join(" · "),
    // The console requires the developer's sign-in, so the link exposes nothing on its own.
    click: `${FIRESTORE_CONSOLE_DATA_URL}~2Ffeedback~2F${encodeURIComponent(feedbackId)}`,
  };
}

/** appVersion is client-supplied, so only a short version-like string is echoed. */
function safeVersion(value) {
  return typeof value === "string" && /^[0-9A-Za-z._+-]{1,40}$/.test(value) ? value : "unknown";
}

module.exports = { buildFeedbackNotification };

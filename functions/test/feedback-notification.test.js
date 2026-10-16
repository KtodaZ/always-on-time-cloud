const assert = require("node:assert/strict");
const test = require("node:test");

const { buildFeedbackNotification, discordPayload } = require("../feedback-notification");

const feedback = {
  message: "The screenshot shows the alarm button disappearing.",
  contactEmail: "person@example.com",
  attachments: [
    { id: "image-1", path: "feedback/abc123/image-1", contentType: "image/png", sizeBytes: 1024,
      downloadUrl: "https://firebasestorage.googleapis.com/v0/b/bucket/o/feedback%2Fabc123%2Fimage-1?token=t" },
    { id: "image-2", path: "feedback/abc123/image-2", contentType: "image/png", sizeBytes: 1024 },
  ],
  diagnosticLog: { id: "log-1", path: "feedback/abc123/log-1" },
  appVersion: "1.2.3",
  source: "android",
  createdAt: new Date("2026-08-26T18:00:00.000Z"),
};

test("the alert says feedback arrived, with only version, platform and attachment counts", () => {
  const notification = buildFeedbackNotification(feedback, "abc123");

  assert.equal(notification.title, "New Always On Time feedback");
  assert.equal(notification.body, "v1.2.3 · Android · 2 screenshots · diagnostics attached");
  assert.equal(
    notification.click,
    "https://console.firebase.google.com/project/always-on-time-zombit-2026/firestore/databases/-default-/data/~2Ffeedback~2Fabc123",
  );
});

test("nothing the user wrote or attached reaches Discord", () => {
  const serialized = JSON.stringify(discordPayload(buildFeedbackNotification(feedback, "abc123")));

  assert.doesNotMatch(serialized, /alarm button/);
  assert.doesNotMatch(serialized, /person@example\.com/);
  assert.doesNotMatch(serialized, /image-1|token=|firebasestorage/);
});

test("a client-supplied version that is not version-like is not echoed", () => {
  const notification = buildFeedbackNotification(
    { ...feedback, appVersion: "1.2.3 call me at 555-0100", attachments: [], diagnosticLog: undefined },
    "abc123",
  );

  assert.equal(notification.body, "vunknown · Android");
});

test("one screenshot is singular and missing fields fall back safely", () => {
  assert.equal(
    buildFeedbackNotification({ attachments: [{}] }, "x").body,
    "vunknown · unknown platform · 1 screenshot",
  );
});

test("the Discord payload is one embed that can never mention anyone", () => {
  const payload = discordPayload(buildFeedbackNotification(feedback, "abc123"));

  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].title, "New Always On Time feedback");
  assert.equal(payload.embeds[0].description, "v1.2.3 · Android · 2 screenshots · diagnostics attached");
  assert.match(payload.embeds[0].url, /~2Ffeedback~2Fabc123$/);
});

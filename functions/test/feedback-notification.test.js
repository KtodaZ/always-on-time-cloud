const assert = require("node:assert/strict");
const test = require("node:test");

const { FakeFirestore } = require("../testing/fake-firestore");
const {
  ALERTS_PER_HOUR, MAX_EVENT_AGE_MS, buildFeedbackNotification, discordPayload, planAlert, publishFeedbackAlert,
} = require("../feedback-notification");

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

test("iPhone feedback names its platform, and unknown sources are not echoed", () => {
  assert.equal(
    buildFeedbackNotification({ ...feedback, source: "ios", appVersion: "1.0+7" }, "abc123").body,
    "v1.0+7 · iPhone · 2 screenshots · diagnostics attached",
  );
  for (const source of ["web", "constructor", "__proto__", "iOS"]) {
    assert.equal(buildFeedbackNotification({ source }, "x").body, "vunknown · unknown platform");
  }
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

const silent = { info() {}, warn() {}, error() {} };

function discord(status = 204) {
  const posts = [];
  return {
    posts,
    fetchImpl: async (url, init) => {
      posts.push(JSON.parse(init.body));
      return { ok: status >= 200 && status < 300, status, headers: new Headers(status === 429 ? { "retry-after": "30" } : {}) };
    },
  };
}

test("Discord 4xx answers, 429 included, are final; server errors retry only while the event is fresh", async () => {
  const now = Date.parse("2026-10-17T10:15:00Z");
  const eventTime = new Date(now - 1000).toISOString();
  for (const status of [400, 401, 404, 429]) {
    const hook = discord(status);
    const outcome = await publishFeedbackAlert({ feedback, feedbackId: "f1", eventTime, db: new FakeFirestore(), webhookUrl: "https://hook", fetchImpl: hook.fetchImpl, logger: silent, now });
    assert.equal(outcome, "refused", String(status));
  }
  await assert.rejects(publishFeedbackAlert({ feedback, feedbackId: "f1", eventTime, db: new FakeFirestore(), webhookUrl: "https://hook", fetchImpl: discord(503).fetchImpl, logger: silent, now }), /HTTP 503/);
  const old = new Date(now - MAX_EVENT_AGE_MS - 1).toISOString();
  const hook = discord(503);
  assert.equal(await publishFeedbackAlert({ feedback, feedbackId: "f1", eventTime: old, db: new FakeFirestore(), webhookUrl: "https://hook", fetchImpl: hook.fetchImpl, logger: silent, now }), "expired");
  assert.equal(hook.posts.length, 0);
});

test("alerts are capped per hour: one summary replaces the overflow, and the next hour says how many were missed", async () => {
  const db = new FakeFirestore();
  const hook = discord();
  const hour = Date.parse("2026-10-17T10:00:00Z");
  const send = (now, id) => publishFeedbackAlert({ feedback, feedbackId: id, eventTime: new Date(now).toISOString(), db, webhookUrl: "https://hook", fetchImpl: hook.fetchImpl, logger: silent, now });
  const outcomes = [];
  for (let i = 0; i < ALERTS_PER_HOUR + 5; i += 1) outcomes.push(await send(hour + i * 1000, `f${i}`));
  assert.deepEqual(outcomes, [...Array(ALERTS_PER_HOUR).fill("single"), "summary", "skipped", "skipped", "skipped", "skipped"]);
  assert.equal(hook.posts.length, ALERTS_PER_HOUR + 1);
  assert.match(hook.posts.at(-1).embeds[0].description, /alerts are paused until 11:00 UTC/);
  assert.equal(await send(hour + 60 * 60 * 1000 + 5, "next"), "single");
  assert.match(hook.posts.at(-1).embeds[0].description, /· 5 more last hour without an alert$/);
  assert.ok(!JSON.stringify(hook.posts).includes("person@example.com"));
  assert.deepEqual(planAlert({ count: 2, previousCount: 50 }), { kind: "single", missedLastHour: 0 });
});

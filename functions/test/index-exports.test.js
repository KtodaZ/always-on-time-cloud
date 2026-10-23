"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

test("index exports the feedback trigger unchanged alongside the iOS push functions", () => {
  const functions = require("../index");
  assert.deepEqual(Object.keys(functions).sort(), [
    "assistantMcp",
    "assistantOauth",
    "calculateTravelRoute",
    "capAssistantDevices",
    "capAssistantSnapshots",
    "capSyncedHistory",
    "deleteOrphanFeedbackUploads",
    "deleteSyncedAccount",
    "deliverIosPushDispatch",
    "iosGoogleWebhook",
    "iosMicrosoftWebhook",
    "iosPushApi",
    "listAssistantConnections",
    "pruneAssistantConnections",
    "pruneSyncedHistory",
    "publishFeedbackNotification",
    "resumeAccountDeletions",
    "revokeAssistantConnection",
    "scheduleIosPushes",
    "sendAssistantUsageSummary",
    "undoAssistantChange",
  ]);

  const feedback = functions.publishFeedbackNotification.__endpoint;
  assert.deepEqual(feedback.region, ["us-central1"]);
  assert.equal(feedback.maxInstances, 1);
  assert.equal(feedback.eventTrigger.eventType, "google.cloud.firestore.document.v1.created");
  assert.deepEqual(feedback.eventTrigger.eventFilterPathPatterns, { document: "feedback/{feedbackId}" });
  assert.equal(feedback.eventTrigger.retry, true);
  assert.deepEqual(feedback.secretEnvironmentVariables, [{ key: "FEEDBACK_DISCORD_WEBHOOK_URL" }],
    "the feedback trigger reads only its webhook secret, never the APNs key");

  const api = functions.iosPushApi.__endpoint;
  assert.deepEqual(api.httpsTrigger, { invoker: ["public"] });
  assert.equal(api.secretEnvironmentVariables, undefined, "the device API never touches the APNs key");
  for (const name of ["iosGoogleWebhook", "deliverIosPushDispatch", "scheduleIosPushes"]) {
    assert.deepEqual(functions[name].__endpoint.secretEnvironmentVariables, [{ key: "APNS_AUTH_KEY_P8" }], name);
  }
  assert.equal(functions.iosMicrosoftWebhook.__endpoint.secretEnvironmentVariables, undefined,
    "the Graph webhook only records work; the dispatch trigger sends the push");

  const dispatch = functions.deliverIosPushDispatch.__endpoint;
  assert.deepEqual(dispatch.region, ["us-central1"]);
  assert.equal(dispatch.eventTrigger.eventType, "google.cloud.firestore.document.v1.created");
  assert.deepEqual(dispatch.eventTrigger.eventFilterPathPatterns, { document: "iosPushDispatches/{dispatchId}" });
  assert.equal(dispatch.eventTrigger.retry, false);
  assert.equal(functions.scheduleIosPushes.__endpoint.scheduleTrigger.schedule, "every 1 minutes");
  assert.equal(functions.scheduleIosPushes.__endpoint.maxInstances, 1);

  const route = functions.calculateTravelRoute.__endpoint;
  assert.deepEqual(route.region, ["us-central1"]);
  assert.ok(route.callableTrigger, "the route proxy is a callable function");
  assert.deepEqual(route.secretEnvironmentVariables, [{ key: "TOMTOM_API_KEY" }, { key: "TRAVEL_ROUTE_API_KEY" }]);

  // The assistant endpoints are public HTTP (Hosting rewrites to them). Only the functions that can
  // push a change, ping or publish request to an iPhone read the APNs key; the others send only
  // `state`, which iPhones skip. Only the weekly summary reads the Discord webhook.
  for (const [name, secrets] of [["assistantMcp", [{ key: "APNS_AUTH_KEY_P8" }]], ["assistantOauth", undefined]]) {
    const endpoint = functions[name].__endpoint;
    assert.deepEqual(endpoint.region, ["us-central1"], name);
    assert.deepEqual(endpoint.httpsTrigger, { invoker: ["public"] }, name);
    assert.deepEqual(endpoint.secretEnvironmentVariables, secrets, name);
  }
  for (const [name, secrets] of [
    ["listAssistantConnections", undefined], ["revokeAssistantConnection", undefined], ["undoAssistantChange", [{ key: "APNS_AUTH_KEY_P8" }]],
  ]) {
    assert.ok(functions[name].__endpoint.callableTrigger, name);
    assert.deepEqual(functions[name].__endpoint.secretEnvironmentVariables, secrets, name);
  }
  assert.equal(functions.pruneAssistantConnections.__endpoint.secretEnvironmentVariables, undefined);
  assert.deepEqual(functions.sendAssistantUsageSummary.__endpoint.secretEnvironmentVariables, [{ key: "FEEDBACK_DISCORD_WEBHOOK_URL" }]);
  assert.equal(functions.sendAssistantUsageSummary.__endpoint.scheduleTrigger.schedule, "every monday 09:00");

  // Storage caps: each trigger fires only on new documents in its own account collection.
  for (const [name, document] of [
    ["capSyncedHistory", "accounts/{uid}/history/{recordId}"],
    ["capAssistantDevices", "accounts/{uid}/assistantDevices/{deviceId}"],
    ["capAssistantSnapshots", "accounts/{uid}/assistantSnapshots/{deviceId}"],
  ]) {
    const endpoint = functions[name].__endpoint;
    assert.equal(endpoint.eventTrigger.eventType, "google.cloud.firestore.document.v1.created", name);
    assert.deepEqual(endpoint.eventTrigger.eventFilterPathPatterns, { document }, name);
    assert.equal(endpoint.secretEnvironmentVariables, undefined, name);
  }
  for (const name of ["deleteOrphanFeedbackUploads", "resumeAccountDeletions"]) {
    assert.ok(functions[name].__endpoint.scheduleTrigger, name);
    assert.equal(functions[name].__endpoint.secretEnvironmentVariables, undefined, name);
  }
  // Deleting a large account can take minutes; a stopped deletion is resumed.
  assert.equal(functions.deleteSyncedAccount.__endpoint.timeoutSeconds, 540);
});

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

test("index exports the feedback trigger unchanged alongside the iOS push functions", () => {
  const functions = require("../index");
  assert.deepEqual(Object.keys(functions).sort(), [
    "calculateTravelRoute",
    "deleteSyncedAccount",
    "deliverIosPushDispatch",
    "iosGoogleWebhook",
    "iosMicrosoftWebhook",
    "iosPushApi",
    "pruneSyncedHistory",
    "publishFeedbackNotification",
    "scheduleIosPushes",
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
});

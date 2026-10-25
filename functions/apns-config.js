"use strict";

// APNs credentials for the assistant connector's iPhone pushes (assistant-functions.js). The iOS
// calendar relay runs on Cloudflare (workers/ios-relay) with its own copy of the key. Here the key
// comes only from Secret Manager at runtime and is readable only by functions that bind
// `apnsAuthKey`; nothing here reads or contains real keys.

const { defineSecret, defineString } = require("firebase-functions/params");

const { createApnsTransport } = require("./apns-transport");

const apnsAuthKey = defineSecret("APNS_AUTH_KEY_P8");
const apnsKeyId = defineString("APNS_KEY_ID", { description: "APNs auth key ID (10 characters)" });
const apnsTeamId = defineString("APNS_TEAM_ID", { description: "Apple developer team ID (10 characters)" });
const apnsTopic = defineString("APNS_TOPIC", { description: "iOS app bundle identifier" });

let transport;

/**
 * The instance's APNs transport (one pooled HTTP/2 connection per APNs environment), created on
 * first use. Throws ApnsConfigError, and tries again on the next call, when the key or params are
 * missing or invalid, for example in a function that does not bind the secret.
 */
function getApnsTransport() {
  if (!transport) {
    transport = createApnsTransport({
      keyPem: apnsAuthKey.value(),
      keyId: apnsKeyId.value(),
      teamId: apnsTeamId.value(),
      topic: apnsTopic.value(),
    });
  }
  return transport;
}

module.exports = { apnsAuthKey, apnsKeyId, apnsTeamId, apnsTopic, getApnsTransport };

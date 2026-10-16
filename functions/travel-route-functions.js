"use strict";

const { getFirestore } = require("firebase-admin/firestore");
const { logger } = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
const { HttpsError, onCall } = require("firebase-functions/v2/https");

const { RouteRequestError, routeTrip } = require("./travel-route");

const tomtomApiKey = defineSecret("TOMTOM_API_KEY");
const travelRouteApiKey = defineSecret("TRAVEL_ROUTE_API_KEY");

// Only genuine Play installs (App Check with Play Integrity) may spend route calls.
exports.calculateTravelRoute = onCall(
  {
    region: "us-central1",
    enforceAppCheck: true,
    maxInstances: 10,
    timeoutSeconds: 20,
    memory: "256MiB",
    secrets: [tomtomApiKey, travelRouteApiKey],
  },
  async (request) => {
    try {
      return await routeTrip({
        data: request.data,
        db: getFirestore(),
        keys: { tomtom: () => tomtomApiKey.value(), google: () => travelRouteApiKey.value() },
        logger,
      });
    } catch (error) {
      if (error instanceof RouteRequestError) throw new HttpsError(error.code, error.message);
      logger.error("Route proxy failed", { name: error?.name });
      throw new HttpsError("internal", "Route proxy failed");
    }
  },
);

"use strict";

const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const { logger } = require("firebase-functions");
const { defineBoolean, defineSecret } = require("firebase-functions/params");
const { HttpsError, onCall } = require("firebase-functions/v2/https");

const { clientNetworkKey } = require("./ios-push-service");
const { RouteRequestError, routeTrip } = require("./travel-route");
const { createRouteMetrics } = require("./travel-route-usage");

const tomtomApiKey = defineSecret("TOMTOM_API_KEY");
const travelRouteApiKey = defineSecret("TRAVEL_ROUTE_API_KEY");
// Anonymous daily totals in travelRouteDaily for the studio dashboard (docs/TRAVEL_ROUTES.md).
const routeMetricsEnabled = defineBoolean("TRAVEL_ROUTE_METRICS", {
  default: false,
  description: "Count route proxy calls in anonymous daily totals (travelRouteDaily)",
});

// One per instance, so refusals held in memory ride along with its next counter write.
let routeMetrics;
function getRouteMetrics() {
  try {
    if (!routeMetricsEnabled.value()) return null;
    routeMetrics ??= createRouteMetrics({ db: getFirestore(), increment: (amount) => FieldValue.increment(amount), logger });
    return routeMetrics;
  } catch (error) {
    // Counting must never stop a route.
    logger.warn("Route metrics unavailable", { name: error?.name });
    return null;
  }
}

// Only genuine Play installs (App Check with Play Integrity) may spend route calls.
exports.calculateTravelRoute = onCall(
  {
    region: "us-central1",
    enforceAppCheck: true,
    // TODO(app-check-replay): set consumeAppCheckToken: true once the app sends limited-use App
    // Check tokens for this call (getLimitedUseAppCheckToken). Until then each token would only
    // work once and ordinary cached tokens would be refused.
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
        metrics: getRouteMetrics(),
        // The caller's network: the last X-Forwarded-For entry, which Google's front end appends
        // and a caller can't choose (rawRequest.ip would be the first, caller-supplied entry or
        // the front end itself, depending on Express's trust proxy setting).
        network: clientNetworkKey(request.rawRequest ?? { headers: {} }),
      });
    } catch (error) {
      if (error instanceof RouteRequestError) throw new HttpsError(error.code, error.message);
      logger.error("Route proxy failed", { name: error?.name });
      throw new HttpsError("internal", "Route proxy failed");
    }
  },
);

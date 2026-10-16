# Travel routes

Travel-time alarms (Android) need a route estimate for an upcoming in-person event. The app calls
the `calculateTravelRoute` callable function instead of calling a routing provider directly, so
the provider API keys stay on the server.

## What the function receives

One route request: start and destination coordinates, the departure or arrival time, transport
mode, the chosen provider (TomTom or Google Routes), whether live traffic is wanted, and the
caller's Firebase installation ID. It does not receive event titles, calendar data or an account
identity.

## What it does with it

1. Rejects the call unless it carries a valid App Check (Play Integrity) token.
2. Increments a per-installation daily counter in `travelRouteUsage/{installationId}`, the only
   thing written. The counter document has an `expiresAt` field covered by a Firestore TTL policy
   ([`firestore.indexes.json`](../firestore.indexes.json)), so idle counters are deleted.
3. Forwards the coordinates and times to the provider, and returns the duration and distance.

Coordinates are not stored or logged. Provider error bodies are logged only with the API key
removed ([`travel-route.js`](../functions/travel-route.js)). The provider processes the request
under its own terms.

## Configuration

Secrets in Secret Manager: `TOMTOM_API_KEY` and `TRAVEL_ROUTE_API_KEY` (Google Routes, restricted
to the Routes API). App Check uses Play Integrity with the Play app signing certificate.

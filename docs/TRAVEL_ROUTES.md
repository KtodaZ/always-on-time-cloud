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
2. Increments three counters in `travelRouteUsage`, the only things written: one per
   installation per day, one per client network per hour (stored under a hash of the network,
   an IPv4 address or IPv6 /64), and one per provider per day for all callers together. A call
   over any of them is refused before it reaches the provider. The counter documents have an
   `expiresAt` field covered by a Firestore TTL policy
   ([`firestore.indexes.json`](../firestore.indexes.json)), so idle counters are deleted.
3. Forwards the coordinates and times to the provider, and returns the duration and distance.
4. When `TRAVEL_ROUTE_METRICS` is on (off by default), adds the call to anonymous daily totals
   (below).

Coordinates are not stored or logged. Provider error bodies are logged only with the API key
removed ([`travel-route.js`](../functions/travel-route.js)). The provider processes the request
under its own terms.

## Configuration

Secrets in Secret Manager: `TOMTOM_API_KEY` and `TRAVEL_ROUTE_API_KEY` (Google Routes, restricted
to the Routes API). App Check uses Play Integrity with the Play app signing certificate.

## Daily totals

With the `TRAVEL_ROUTE_METRICS` param set to `true`, the function keeps one document of counters
per UTC day, `travelRouteDaily/{yyyy-mm-dd}`, for the studio's private analytics dashboard (the
`zombit-studios-analytics` project, which reads them with Datastore Viewer)
([`travel-route-usage.js`](../functions/travel-route-usage.js)):

| Field | Counts |
| --- | --- |
| `installsActive` | installations whose first accepted call of the day this was |
| `requests.{tomtom,google}.{drive,transit,bicycle,walk}` | provider requests made, including failed ones |
| `sku.{tomtom_routing,google_routes_essentials,google_routes_pro}` | the same requests by billing SKU; Google is Pro for traffic-aware drives, Essentials otherwise |
| `outcomes.{tomtom,google}.{ok,http4xx,http429,http5xx,unreachable}` | how each request ended |
| `refused.{invalid,allowance,not_configured}` | calls turned away before reaching a provider |
| `schemaVersion` | the layout above (1) |

The documents hold numbers only: no installation ID, network, coordinates, address or key. The
active-install count comes from the existing per-installation counter's transaction, so nothing
more about an installation is kept, and installations are counted per day only (not unique users
over longer periods).

The totals are best-effort. They lean towards undercounting:

- A counter write that fails or takes longer than 2 seconds is dropped, not retried. The route
  reply is unaffected either way; a timed-out write may still land later.
- An instance that stops between the allowance and the counter write loses that call's counts.
- Refusals are held in the instance's memory and written with its next counter write, or alone
  at most once a minute, so they don't add a write per refused call; an instance shut down
  meanwhile loses them.
- `sku` counts requests sent, an upper bound on what the provider bills.
- Increments aren't idempotent, so in the rare case the Firestore client retries a write that had
  already committed, that call counts twice.

There is no TTL on these documents; a year of them is a few hundred small documents.

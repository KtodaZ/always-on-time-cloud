# iOS Relay Push Protocol (v2)

The iOS app keeps calendars fresh while closed by waking its Notification Service Extension (NSE)
with APNs alert pushes. This document is the contract between the iOS app/NSE and the relay, a
Cloudflare Worker with Durable Objects in [`workers/ios-relay/`](../workers/ios-relay/).

The server is a relay only. The device keeps its OAuth tokens, creates provider subscriptions,
fetches calendar changes itself, and reconciles alarms. The server stores:

- the APNs token and environment, a SHA-256 hash of the install secret, and the freshness settings
  (whether the device polls EventKit calendars, its active hours and time zone, and how long its
  alarms ring);
- SHA-256 hashes of opaque alarm IDs with their trigger times (no titles or calendar IDs);
- provider subscription mappings: SHA-256 hashes of the subscription ID, of the Google
  `resourceId`, and of the channel token or `clientState`, plus the expiration;
- push bookkeeping: when the last push was accepted and of which kind, when the device last
  reported a sync, pending work, failures and rate-limit counters.

It never receives OAuth tokens, event content, meeting links, raw channel tokens or `clientState`
values, or provider notification payloads beyond the fields needed to route them. Cloudflare
processes this data for us (Workers and Durable Objects storage). There is no other database.

Version 1 of this protocol ran on Firebase Functions (`/v1/...`) and was retired before the iOS
app shipped; v2 is not backwards compatible with it and v1 routes answer `404`.

## 1. Conventions

- Base URL: `https://aot-ios-relay.kylemail2003.workers.dev` (a custom domain may replace it
  before launch; the paths stay the same).
  - Device API: `<base>/v2/...`
  - Google webhook: `<base>/webhooks/google`
  - Graph webhook: `<base>/webhooks/microsoft`
- Request and response bodies are UTF-8 JSON. Device API bodies are limited to 32 KiB.
- Every object is strict: a missing required field or any unknown field is a `400`.
- Times are Unix epoch milliseconds (integers) unless stated otherwise.
- Every response carries `Cache-Control: no-store`. Error bodies are `{"error": "<message>"}`;
  messages are for logs only, so branch on the status code.
- Path segments (install ID, provider subscription IDs) must be percent-encoded. Subscription IDs
  may not contain `/`, `\`, whitespace, or non-ASCII characters and are at most 256 characters.

| Status | Meaning |
| --- | --- |
| `200` / `201` / `202` / `204` | Success, as listed per endpoint |
| `400` | Invalid JSON, schema mismatch, or invalid value |
| `401` | Missing or invalid App Check token or install credentials (also: install no longer exists) |
| `403` | Google webhook with a wrong channel token |
| `404` | Unknown route |
| `405` | Method not allowed; see the `Allow` header |
| `409` | Install ID or subscription ID owned by someone else; subscription limit reached |
| `413` | Body too large |
| `429` | Rate limited; retry with exponential backoff starting at 30 s |
| `500` | Server error; retry with backoff |

Order of checks on authenticated calls: a missing or malformed `Authorization` header is `401`,
then an App Check token that was sent but is invalid is `401`, then the body is validated (`400`
/ `413`), then the install secret and rate limit are checked (`401` / `429`).

## 2. Install identity and authentication

Before first registration the app generates and stores, in a keychain access group shared with
the NSE (accessible after first unlock):

- `installId`: 16 random bytes, base64url without padding (exactly 22 characters).
- `installSecret`: 32 random bytes, base64url without padding (exactly 43 characters).

The server stores only `sha256(installSecret)`. Every call after registration sends
`Authorization: Bearer <installSecret>`. Authenticated calls are limited to 60 per install per
minute (`429` beyond that); every authenticated endpoint counts, including `/synced`.

Firebase App Check (`X-Firebase-AppCheck: <token>`):

- `POST /v2/installations` requires a valid token. (The `ENFORCE_APP_CHECK` Worker variable can be
  set to `false` for development; an invalid token is still rejected.)
- All other device calls accept but do not require a token, because the NSE may not be able to
  obtain one. If a token is sent, it must be valid.
- The relay verifies the token itself: an RS256 JWT whose signature matches a key from
  `https://firebaseappcheck.googleapis.com/v1/jwks` (keys cached for up to 6 hours and refetched
  for an unknown key ID, but fetched at most once a minute, failed fetches included; stale keys
  stay in use while Google is unreachable), with issuer
  `https://firebaseappcheck.googleapis.com/1054144143721`, an audience that includes
  `projects/1054144143721` (project `always-on-time-zombit-2026`), the iOS app ID
  `1:1054144143721:ios:20196992cb6f6edb9f5df8` as subject, and an `exp` in the future. There is no
  replay protection, so clients send ordinary cached tokens, not limited-use ones.

The iOS app gets tokens from the Firebase App Check SDK: App Attest on devices, the debug
provider only in Debug simulator builds (its debug token must be registered for the iOS app in
Firebase). It sends a token on registration only. A token it cannot obtain means the
registration is not sent; a refused token (`401`) is retried once with a fresh one, then
reported. Either way the app shows background updates as not registered and retries with
backoff from 30 s. The NSE does not use App Attest and sends no token, so its lost-install
re-registration succeeds only with enforcement off; otherwise the app registers again at its next
launch.

If any authenticated call returns `401` and the bearer secret is correct, the install no longer
exists on the server (deleted, or disabled by APNs and pruned after 30 days). Generate a new
`installId` and `installSecret`, register again, then re-send alarms and subscriptions.

## 3. Device API

### 3.1 Register: `POST /v2/installations`

```json
{
  "installId": "AbCdEfGhIjKlMnOpQrStUv",
  "installSecret": "<43 base64url characters>",
  "apnsToken": "<APNs device token, lowercase hex, 64-200 characters>",
  "environment": "production",
  "freshness": {
    "polling": true,
    "activeHours": { "start": "06:00", "end": "23:00" },
    "timeZone": "America/Los_Angeles",
    "ringSeconds": 300
  }
}
```

- `environment`: `development` (sandbox APNs, debug builds) or `production` (TestFlight/App Store).
- `freshness.polling`: `true` when at least one selected calendar is read only through EventKit
  (after the app deselects EventKit copies of accounts signed in inside the app), otherwise
  `false`. Polling installs get meeting-window prechecks and hourly heartbeats (section 6);
  non-polling installs rely on provider webhooks plus two prechecks per alarm.
- `freshness.activeHours`: `HH:mm` 24-hour local times in `timeZone` (an IANA name, matched
  case-insensitively and stored in its canonical spelling). `start` is
  included, `end` excluded, ranges may cross midnight (`22:00`-`06:00`), and `start` may not equal
  `end`. They limit heartbeats only. The app's default is `06:00`-`23:00`.
- `freshness.ringSeconds` (optional, integer 0-86400): the app's "Alarm duration" setting, how
  long an unanswered alarm rings before the device stops it (Android's `alarm_duration_seconds`;
  default 300). With a positive value the relay sends a `ringEnd` wake after each armed trigger
  (section 6); `0` (until dismissed) or no value sends none. AlarmKit gives apps no ring length
  and runs no app code when an alarm rings, so without a wake an untouched alarm alerts until
  someone acts (IOS-BUG-55).

Optional receipt fields (section 3.7): `"receiptVersion": 1` opts the install into delivery
receipts; `"deliveryEligible": false` tells the relay that notification alerts are off, so the NSE
cannot run and no push is sent until an update sets it back to `true` (pending work is kept).

- `environment` is a hint. The relay remembers the environment where a token first got APNs `200`
  and keeps using it for that token whatever later registrations say; a new token starts
  unverified (section 6).

Responses: `201 {"installId": "..."}` when created; `200 {"installId": "..."}` when the same
`installId` and `installSecret` are repeated (safe to retry, updates the fields above and
re-enables the install); `409` if the `installId` exists with a different secret.

Rate limit: 20 registration attempts per client network per hour (IPv4 address or IPv6 /64, from
Cloudflare's `CF-Connecting-IP`). New installs are also capped at 2,000 per hour overall; an
install that is already registered can always register again. (A future option is to require
limited-use App Check tokens with replay protection for registration, which would let the
overall cap rise.)

### 3.2 Update: `PUT /v2/installations/{installId}`

Body: `apnsToken`, `environment`, and `freshness` exactly as in 3.1. Returns `204`. Call this on
every app launch and whenever the APNs token, time zone, active hours or `polling` changes (for
example after signing in to or out of a provider changes which calendars are read through
EventKit). It re-enables an install that APNs disabled.

### 3.3 Delete: `DELETE /v2/installations/{installId}`

Returns `204`. Deletes the install, its alarm triggers, and all its subscription mappings. Call
it when the user turns off background refresh or signs out of every provider, after stopping the
provider subscriptions.

### 3.4 Alarm triggers: `PUT /v2/installations/{installId}/alarms`

```json
{
  "alarms": [
    { "id": "<opaque alarm id>", "triggerAtMs": 1791406800000 }
  ]
}
```

- A full snapshot that replaces the previous one. `[]` clears it.
- At most 128 entries; send the soonest. `id` is an opaque, stable string (1-200 characters, no
  control characters) unique within the request. Do not put titles or calendar identifiers in it;
  the server stores only `sha256(id)` but the value should be meaningless anyway.
- Entries whose trigger is not in the future, or is more than 90 days ahead, are ignored rather
  than rejected.
- Re-sending an unchanged `id` + `triggerAtMs` keeps its sent-precheck markers; changing the
  trigger resets them.
- `armed` (optional boolean, also in receipts): `false` for a desired alarm AlarmKit has not
  armed. Absent means armed. Only armed triggers get a ring-end wake.
- Snapshots carry future triggers only. A trigger that has passed and still has a ring-end wake
  to send is kept when a snapshot leaves it out, until a push covers its ring end (section 6) or
  retention removes it a day later. A future trigger left out (moved, cancelled) is deleted at
  once, so its ring-end wake never goes out.
- Send after every reconcile that changes armed alarms (app or NSE). Returns `204`.

### 3.5 Provider subscriptions

```text
PUT    /v2/installations/{installId}/subscriptions/google/{channelId}
DELETE /v2/installations/{installId}/subscriptions/google/{channelId}
PUT    /v2/installations/{installId}/subscriptions/microsoft/{subscriptionId}
DELETE /v2/installations/{installId}/subscriptions/microsoft/{subscriptionId}
```

Google `PUT` body:

```json
{
  "resourceId": "<resourceId returned by events.watch>",
  "expiresAtMs": 1792008000000,
  "channelTokenHash": "<lowercase hex sha256 of the UTF-8 channel token>"
}
```

Microsoft `PUT` body:

```json
{
  "expiresAtMs": 1791662400000,
  "clientStateHash": "<lowercase hex sha256 of the UTF-8 clientState>"
}
```

- `expiresAtMs` must be in the future and at most 366 days ahead.
- `PUT` creates or replaces the mapping (send it again after every renewal with the new
  expiration) and returns `204`. At most 64 live subscriptions per install (`409` beyond that).
  A subscription ID registered to a different install returns `409`, unless that install no
  longer holds it (deleted or pruned), in which case the new install takes it over.
- `DELETE` returns `204`, including when the mapping does not exist or belongs to someone else.

Provider setup the device must use:

- Google `events.watch`: `type: "web_hook"`, `address`: the Google webhook URL, `id`: a random
  UUID, `token`: at least 32 random bytes base64url-encoded (Google allows up to 256 characters).
  Google channels cannot be extended: to renew, create a new channel, `PUT` it, then stop the old
  channel and `DELETE` its mapping.
- Microsoft Graph subscriptions: `notificationUrl` and `lifecycleNotificationUrl`: the Graph
  webhook URL, `clientState`: at least 32 random bytes base64url-encoded (Graph allows up to 128
  characters). Renew with `PATCH` and `PUT` the new expiration.

### 3.6 Report a sync: `POST /v2/installations/{installId}/synced`

```json
{ "syncedAtMs": 1791403200000 }
```

Call this after a successful full sync (provider deltas fetched, EventKit re-read, alarms
reconciled) that did **not** come from a relay push: app open, an EventKit change while running,
background app refresh, alarm intents. Do not call it from the NSE for a relay push; the server
already counts accepted pushes.

- `syncedAtMs` is when the sync **started** reading calendars, so a change the server recorded
  after that moment is not considered covered. It may be at most 60 seconds ahead of the server
  clock (`400` beyond that) and is clamped to the server clock.
- A value at or before the install's newest accepted push or reported sync is ignored (still
  `204`).
- Returns `204`.

The server treats a reported sync like an accepted push for freshness (section 6): it resets the
heartbeat clock and the 5-minute meeting-window gap, satisfies precheck stages that started at or
before `syncedAtMs`, and clears a pending change recorded at or before `syncedAtMs`. It does not
satisfy renewals (only the device renewing its subscriptions does) and does not count toward the
2-minute push coalescing, which limits pushes, not syncs.

### 3.7 Delivery receipts (`receiptVersion: 1`)

For receipt installs, APNs `200` proves only transport. Each push carries `aot.deliveryId`
(section 5); after every sync, the app or NSE posts a receipt to the same `/synced` endpoint:

```json
{
  "receiptVersion": 1, "syncedAtMs": 1791403200000, "snapshotRevision": 42,
  "deliveryId": "6f1c...", "calendarVerified": true, "alarmsReconciled": true,
  "alarms": [{ "id": "<opaque>", "triggerAtMs": 1791406800000, "armed": true }],
  "nextRefreshAtMs": 1791489600000
}
```

- `snapshotRevision`: increases with every receipt the device sends (shared by app and NSE). A
  receipt with a newer revision replaces the trigger snapshot (as 3.4) and the horizon; an older
  one can still acknowledge its own `deliveryId`.
- `deliveryId`: the `aot.deliveryId` of the push that caused the sync; omitted for syncs the
  device started itself (app open, background refresh, alarm intents).
- `calendarVerified`: every selected calendar was read completely. `alarmsReconciled`: AlarmKit
  matches the plan. A sync that returned busy, was cut off, or read only cached data sends
  `false` (or nothing).
- `nextRefreshAtMs`: when the device next needs a wake: the next trigger entering its alarm
  horizon, a deferred alarm's refill, or one day after this read, whichever is first.

The relay clears pending work only for a receipt that matches the outstanding delivery, verifies
calendars and alarms, and whose delivery was issued after the newest webhook. Freshness counts from
the delivery's issue time (or the device's `syncedAtMs`, clamped, for self-started syncs).
Without a matching receipt a delivery that carries a change or a horizon deadline is resent at
0, 2, 4, 8 and 16 minutes, then stops (the work stays pending; a newer webhook starts a new burst).

### 3.8 Status: `GET /v2/installations/{installId}`

Returns `200` with what the relay knows about the install, for the app's health screen:
`enabled`, `disabledReason` (`apns_unregistered`, `apns_bad_device_token` or `null`),
`environment` and `environmentVerified`, `receiptVersion`, `deliveryEligible`,
`lastVerifiedAtMs`, `lastPushAtMs`, `unacknowledgedDeliveries` and `nextRefreshAtMs`. `401` means
the relay no longer knows the install: register again (3.1).

## 4. Webhooks (server behavior)

Routing: the relay stores, for each subscription, an index entry (`sha256` subscription key ->
install ID) in the shard chosen by a hash of the subscription key (section 8). A webhook looks the
subscription up there, then asks the install's shard to verify and record it. Nothing scans. A
`PUT` (3.5) writes the index entry just before the subscription mapping, so a webhook that finds
an entry without its mapping removes the entry only when it was last written at least 5 minutes
ago; a Google `sync` notification racing the channel's own `PUT` cannot orphan it.

Google (`POST <base>/webhooks/google`):

1. `X-Goog-Channel-ID` is required (`400` otherwise). Unknown or expired channel: `204`, no push.
2. `sha256(X-Goog-Channel-Token)` must equal the stored hash, else `403`.
3. `sha256(X-Goog-Resource-ID)` must equal the stored `resourceId` hash, else `204`, no push.
4. `X-Goog-Resource-State`: `sync` is acknowledged without a push; `exists` and `not_exists`
   record a change for the install. Other values are ignored. Bodies are never read.

Microsoft Graph (`<base>/webhooks/microsoft`):

- Validation: a `POST` (or `GET`) with `?validationToken=...` is answered `200` with the decoded
  token as `text/plain` (`400` if empty or over 2,048 characters).
- Notifications: `POST` with a `value` array (at most 1,000 items naming at most 100 distinct
  subscriptions, 1 MiB; larger batches get `400` / `413`). Each item is matched by
  `subscriptionId`; items without a string `clientState`, unknown subscriptions and items whose
  `sha256(clientState)` does not match are skipped. Items without `lifecycleEvent` and `missed`
  lifecycle events record a change. `reauthorizationRequired` and `subscriptionRemoved` request
  an immediate renew push. Multiple items for one install produce at most one push. The response
  is `202`.
- Expired subscriptions: change notifications for a subscription past its recorded
  `expiresAtMs` are skipped. Lifecycle events (`reauthorizationRequired`, `subscriptionRemoved`,
  `missed`) for it are still verified and routed, because Graph only sends them for a
  subscription it still knows (for example one the device renewed whose `PUT` never arrived).
  Each such renewal request produces one `renew` push, not the 6-hour retries of section 6.
  Expired mappings are kept for 7 days for this, and do not count against the 64-subscription
  limit.

Delivery: neither webhook calls APNs while the provider waits. The install's shard records the
change or renewal request in SQLite and, if a push may go out now, sets its Durable Object alarm to
fire immediately; the alarm sends the push (typically within a second). Graph's ~3-second answer
limit is therefore never at risk. A change that cannot go out yet (coalescing, backoff, a push in
flight) stays pending and the shard alarm sends it as soon as allowed; a transient APNs failure is
retried the same way. Webhooks return success once the work is recorded and `500` only when it
could not be stored. Disabled installs record nothing.

## 5. Push format

Every push is an APNs alert so iOS runs the NSE, including after force quit and in Low Power Mode.

APNs request headers:

| Header | Value |
| --- | --- |
| `apns-push-type` | `alert` |
| `apns-topic` | the app bundle ID (`APNS_TOPIC`) |
| `apns-priority` | `5` for `heartbeat`; `10` for `change`, `precheck`, `renew`, `ringEnd` |
| `apns-collapse-id` | `aot-sync` for every relay push |
| `apns-expiration` | send time + 24 hours |

Relay payload (always exactly these keys; `aot.provider` is optional):

```json
{
  "aps": {
    "alert": { "title": "Keeping your alarms up to date", "body": "Checking for calendar updates." },
    "mutable-content": 1,
    "interruption-level": "passive"
  },
  "aot": { "v": 1, "kind": "change", "provider": "google", "at": 1791403200000 }
}
```

| Field | Values |
| --- | --- |
| `aot.v` | Payload version, still `1` (the payload did not change with the v2 device API) |
| `aot.kind` | `change`, `heartbeat`, `precheck`, `renew`, or `ringEnd`; `assistant` for the assistant connector's pushes, which add fields of their own ([assistant protocol](ASSISTANT_PROTOCOL.md#apns-iphone)) |
| `aot.provider` | `google` or `microsoft`; present on `change` and on `renew` when every subscription due for renewal belongs to one provider |
| `aot.at` | Server send time, epoch ms |
| `aot.deliveryId` | Receipt installs only: echo it in the receipt (3.7) |

The payload never contains alarm IDs or times, subscription IDs, or calendar data.

NSE handling rules:

1. Every push, whatever its kind, means "sync now": fetch provider deltas, re-read EventKit,
   reconcile and arm alarms, then `PUT` the alarm snapshot if it changed. The server counts any
   accepted push as satisfying pending changes, heartbeats, and due prechecks.
2. `renew` also means: renew any provider subscription expiring within 24 hours, recreate any
   that were removed, and `PUT` the new mappings. The NSE should do this opportunistically on
   any wake as well; the push is a reminder, not the only trigger.
3. `provider` and `kind` are hints for ordering work within the NSE time budget, nothing more.
   Every wake, whatever its kind, first stops any alarm still alerting after its ring time ran
   out (it records History and posts the Missed notice), then syncs. `ringEnd` exists only to
   cause such a wake; the device decides from its own alarm list, so a late, duplicate or stale
   `ringEnd` (an alarm already stopped, snoozed or moved) changes nothing.
4. Unknown `aot.v` or `kind`, or a missing `aot`: treat as a plain sync.
5. Every push replaces the previous notification via the shared collapse ID and is passive, so
   the user sees one quiet entry. The NSE may rewrite the title/body but must deliver a
   notification. Assistant pushes without an alert of their own
   ([assistant protocol](ASSISTANT_PROTOCOL.md#push-messages)) use the same `aot-sync` collapse ID,
   so relay and assistant syncs share that one entry.

## 6. Scheduling and coalescing

Freshness target: a calendar change reaches the phone within 5 minutes around meetings without
draining the battery. Each install's **freshness point** is the newer of its last accepted push
and its last reported sync (3.6).

| Push | Who | When | `apns-priority` |
| --- | --- | --- | --- |
| `change` | everyone | a Google or Graph webhook recorded a change; immediately, subject to coalescing | 10 |
| `renew` | everyone | 24 hours before a subscription expires, after a Graph `reauthorizationRequired` / `subscriptionRemoved`; then every 6 hours | 10 |
| `precheck` (meeting window) | `polling: true` | for each alarm trigger T, inside [T-30 min, T), whenever at least 5 minutes have passed since the freshness point. About six pushes per isolated alarm (T-30, -25, ... -5); overlapping windows share pushes. Not limited by active hours. | 10 |
| `precheck` (stages) | `polling: false` | at T-20 and T-8 for each alarm, a safety net for silently dead provider channels. Not limited by active hours. | 10 |
| `heartbeat` | `polling: true` only | 60 minutes after the freshness point (or registration), inside active hours | 5 |
| `ringEnd` | `ringSeconds` > 0 | for each armed trigger T, at T + `ringSeconds` + 20 s, unless a push accepted at or after T + `ringSeconds` already covered it. Not limited by active hours or the 2-minute coalescing. Dropped one hour after it was due. | 10 |

Rules shared by all kinds:

- Coalescing: at most one push per install per 2 minutes, counted from the last push APNs
  accepted. While a push is in flight the install is claimed in the shard's memory (the claim
  expires after 2 minutes; if the shard restarts the claim is lost and the push may be sent
  twice; both carry the `aot-sync` collapse ID). After an APNs failure other than an invalid token, the install backs off for 1,
  2, 4, 8, 16, then 30 minutes; pending work is kept.
- When several things are due at once, one push is sent, chosen in this order: `ringEnd`,
  `precheck`, `change`, `renew`, `heartbeat`. Deferred work goes out at the next allowed time.
- Ring ends: the one exception to coalescing, since a ringing alarm should stop on time and each
  trigger has at most one. A `ringEnd` still waits for a push in flight and for an APNs failure
  backoff. Any accepted push sent at or after T + `ringSeconds` covers that trigger's ring end
  (every wake stops overdue alarms), so a precheck or change push in that moment replaces it. Ring
  ends are sent once, not resent until a receipt arrives: the device also stops overdue alarms on
  every other wake (app opened, background refresh, any push).
- A heartbeat due when a meeting window opens within the next 2 minutes is sent as a priority-10
  `precheck` instead.
- Stages (non-polling): a stage is due from its start for 2 minutes. A priority-10 push sent within
  the 2 minutes before a stage starts also satisfies it, as does a reported sync that started at
  or after the stage start. Each stage is sent at most once per trigger time.
- Renewal: a subscription becomes due 24 hours before `expiresAtMs`, or immediately after a Graph
  lifecycle request (also after expiry, see section 4). After an accepted `renew` push the server
  asks again every 6 hours until the device `PUT`s a new expiration or the subscription expires.
- Receipt installs (3.7) follow these rules instead of the table's precheck rows. Freshness counts
  only from verified receipts. Polling installs are checked every 4 minutes in [T-30 min, T).
  Signed-in-only installs get the T-20 and T-8 stages; a stage stays due from its start until a
  verified receipt at or after its start, or until T, so APNs backoff delays a stage but never
  skips it. Repeated attempts for an unverified stage are spaced 4 minutes apart. A horizon wake
  is due at `nextRefreshAtMs`, and at the latest one day after the last wake or verified sync.
- `400 BadDeviceToken` for a token never accepted by APNs is retried once on the other APNs host
  (a development-signed build registered as production, or the reverse). If that host accepts,
  it is remembered for the token. `410`, authentication errors and timeouts never probe.
- APNs `410`, or `400` with reason `BadDeviceToken`, disables the install (unless its token changed
  while the push was in flight). Disabled installs get no pushes and record no webhook work until
  the app sends 3.1 or 3.2. Disabled installs are deleted after 30 days.

Each install stores `next_wake_at` (the next time anything could be due) and `priority_wake_at`
(the next precheck, ring end or pending change). A shard sets its Durable Object alarm to the earliest
`next_wake_at` among its installs (or its next retention cleanup). An alarm run makes at most
`MAX_SUBREQUESTS_PER_RUN` outbound calls (default 40, within the Workers Free limit of 50
subrequests per invocation). It reserves 2 for the shared APNs provider token and 2 per push (the
request and its one retry; 4 for a token whose environment is not verified yet), and retention may use a quarter for index releases (always at least
one install), so the default sends up to 19 pushes per run, never more than 200. Prechecks and
changes go first, with up to 8 APNs requests in flight; if more are due the next run starts
immediately. So heartbeats and renewals cannot delay the pushes that keep alarms right.

## 7. Versioning

- `aot.v` versions the push payload. Within v1, optional fields may be added; clients must ignore
  unknown fields. Changing the meaning of an existing field or kind requires `v: 2`. A new `kind`
  value is allowed within v1 because rule 4 above makes clients treat it as a sync.
- The device API is versioned by path (`/v2/...`). Within v2 the server will not add required
  request fields or remove response fields; new optional endpoints (like 3.6) may be added.
  Incompatible changes get a `/v3` route, served alongside `/v2` until old app versions are
  retired.

## 8. Server configuration and storage

The Worker `aot-ios-relay` is deployed by hand from [`workers/ios-relay/`](../workers/ios-relay/)
with `npx wrangler deploy` ([deploying](DEPLOYING.md#ios-relay-cloudflare-worker)).

| Name | Kind | Purpose |
| --- | --- | --- |
| `APNS_AUTH_KEY_P8` | Worker secret | APNs token-auth `.p8` key (EC P-256, PEM); the same key as the Firebase secret of that name |
| `APNS_KEY_ID` | var | 10-character key ID |
| `APNS_TEAM_ID` | var | 10-character Apple team ID |
| `APNS_TOPIC` | var | App bundle ID |
| `ENFORCE_APP_CHECK` | var, `"true"` | Require App Check for registration |
| `APP_CHECK_PROJECT_NUMBER` | var | Firebase project number for the App Check issuer and audience |
| `APP_CHECK_APP_IDS` | var | Comma-separated Firebase app IDs accepted as the token subject |
| `MAX_SUBREQUESTS_PER_RUN` | var, `"40"` | Outbound calls per shard alarm run (section 6). Safe for Workers Free; on Workers Paid (10,000 subrequests) raise it, e.g. to `"400"` |
| `SHARDS` | Durable Object binding | The 64 `InstallShard` objects |
| `APNS_TOKEN` | Durable Object binding | One `ApnsTokenAuthority` object holding the shared APNs provider token |

APNs uses token-based authentication: an ES256 JWT (`kid` = key ID, `iss` = team ID, `iat`)
signed with WebCrypto. One token serves the whole relay, so Apple never sees more than one token
update per 40 minutes (`TooManyProviderTokenUpdates` cannot occur): the `ApnsTokenAuthority`
Durable Object signs it, keeps it in its storage, and replaces it when it is 40 minutes old or
after APNs answers `403 ExpiredProviderToken` / `InvalidProviderToken`, but never within 20 minutes
of signing. Shards cache it in isolate memory until it is 40 minutes old. Requests go to
`api.push.apple.com` or `api.sandbox.push.apple.com` by the install's `environment` over the
Workers `fetch` API (HTTP/2); a request that fails before APNs answers is retried once. `wrangler
dev` has no HTTP/2, so APNs works only deployed; the tests mock it.

Storage: 64 `InstallShard` Durable Objects with SQLite storage, named `shard-0` to `shard-63`.
A key's shard is the first 32 bits of `sha256(key)` modulo 64; the count cannot change without
migrating data. Keys are `install:<installId>` for an install and everything it owns (alarm
triggers, subscription mappings, push bookkeeping and per-install rate limit),
`subscription:<subscription key>` for the subscription index entry, and `rate:<sha256 of the
rate-limit key>` for registration counters. A subscription key is
`<provider>_<sha256("<provider>:<subscriptionId>")>`. A push writes one install row (plus its
`next_wake_at` index entry) in the install's shard, about 2 billed rows, and any satisfied
precheck or renewal rows.

Retention, run from each shard's alarm: registration counters are deleted when their hour ends
(they are keyed by an unsalted `sha256` of the client network, which is guessable for IPv4 but
holds only a count); subscription mappings and index entries 7 days after they expire; alarm
triggers a day after they pass (with their ring-end markers); installs 30 days after APNs disabled them, with their mappings and
index entries. Deleting an install (3.3) removes everything at once.

Logs: Workers Logs keep only the Worker's own JSON lines, which carry install IDs, push kinds,
APNs status codes and error names, never tokens, secrets, IP addresses or request headers.
Invocation logs (`observability.logs.invocation_logs: false`) are off, because they would record
request metadata such as `X-Goog-Resource-URI` (which names the calendar), App Check tokens and
client IPs.

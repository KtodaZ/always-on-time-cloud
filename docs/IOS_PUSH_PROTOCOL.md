# iOS Relay Push Protocol (v1)

The iOS app keeps calendars fresh while closed by waking its Notification Service Extension (NSE)
with APNs alert pushes. This document is the contract between the iOS app/NSE and the Firebase
functions in `functions/ios-push-*.js`.

The server is a relay only. The device keeps its OAuth tokens, creates provider subscriptions,
fetches calendar changes itself, and reconciles alarms. The server stores:

- the APNs token and environment, a SHA-256 hash of the install secret, and heartbeat preferences;
- SHA-256 hashes of opaque alarm IDs with their trigger times (no titles or calendar IDs);
- provider subscription mappings: SHA-256 hashes of the subscription ID (as the document key), of
  the Google `resourceId`, and of the channel token or `clientState`, plus the expiration.

It never receives OAuth tokens, event content, meeting links, raw channel tokens or `clientState`
values, or provider notification payloads beyond the fields needed to route them.

## 1. Conventions

- Base URLs (project `always-on-time-zombit-2026`, region `us-central1`):
  - Device API: `https://us-central1-<project>.cloudfunctions.net/iosPushApi`
  - Google webhook: `https://us-central1-<project>.cloudfunctions.net/iosGoogleWebhook`
  - Graph webhook: `https://us-central1-<project>.cloudfunctions.net/iosMicrosoftWebhook`
- Request and response bodies are UTF-8 JSON. Device API bodies are limited to 32 KiB.
- Every object is strict: a missing required field or any unknown field is a `400`.
- Times are Unix epoch milliseconds (integers) unless stated otherwise.
- Every response carries `Cache-Control: no-store`. Error bodies are `{"error": "<message>"}`;
  messages are for logs only, so branch on the status code.
- Path segments (install ID, provider subscription IDs) must be percent-encoded. Subscription IDs
  may not contain `/`, `\`, whitespace, or non-ASCII characters and are at most 256 characters.

| Status | Meaning |
| --- | --- |
| `200` / `201` / `204` | Success, as listed per endpoint |
| `400` | Invalid JSON, schema mismatch, or invalid value |
| `401` | Missing or invalid App Check token or install credentials (also: install no longer exists) |
| `404` | Unknown route |
| `405` | Method not allowed; see the `Allow` header |
| `409` | Install ID or subscription ID owned by someone else; subscription limit reached |
| `413` | Body too large |
| `429` | Rate limited; retry with exponential backoff starting at 30 s |
| `500` | Server error; retry with backoff |

## 2. Install identity and authentication

Before first registration the app generates and stores, in a keychain access group shared with
the NSE (accessible after first unlock):

- `installId`: 16 random bytes, base64url without padding (exactly 22 characters).
- `installSecret`: 32 random bytes, base64url without padding (exactly 43 characters).

The server stores only `sha256(installSecret)`. Every call after registration sends
`Authorization: Bearer <installSecret>`. Authenticated calls are limited to 60 per install per
minute (`429` beyond that).

Firebase App Check (`X-Firebase-AppCheck: <token>`):

- `POST /v1/installations` requires a valid token. (The server can relax this with the
  `IOS_PUSH_ENFORCE_APP_CHECK=false` parameter for development; an invalid token is still rejected.)
- All other device calls accept but do not require a token, because the NSE may not be able to
  obtain one. If a token is sent, it must be valid.
- The server verifies with `verifyToken` and no replay protection (`consume`), so clients send
  ordinary cached tokens, not limited-use ones.

The iOS app gets tokens from the Firebase App Check SDK: App Attest on devices, the debug
provider only in Debug simulator builds (its debug token must be registered for the iOS app in
Firebase). It sends a token on registration only. A token it cannot obtain means the
registration is not sent; a refused token (`401`) is retried once with a fresh one, then
reported. Either way the app shows background updates as not registered and retries with
backoff from 30 s. The NSE does not use App Attest and sends no token, so its lost-install
re-registration (section 2) succeeds only with enforcement off; otherwise the app registers
again at its next launch.

If any authenticated call returns `401` and the bearer secret is correct, the install no longer
exists on the server (deleted, or disabled by APNs and pruned after 30 days). Generate a new
`installId` and `installSecret`, register again, then re-send alarms and subscriptions.

## 3. Device API

### 3.1 Register: `POST /v1/installations`

```json
{
  "installId": "AbCdEfGhIjKlMnOpQrStUv",
  "installSecret": "<43 base64url characters>",
  "apnsToken": "<APNs device token, lowercase hex, 64-200 characters>",
  "environment": "production",
  "heartbeat": {
    "intervalMinutes": 20,
    "activeHours": { "start": "07:00", "end": "22:00" },
    "timeZone": "America/Los_Angeles"
  }
}
```

- `environment`: `development` (sandbox APNs, debug builds) or `production` (TestFlight/App Store).
- `heartbeat.intervalMinutes`: integer 15-30.
- `heartbeat.activeHours`: `HH:mm` 24-hour local times in `timeZone` (an IANA name). `start` is
  included, `end` excluded, ranges may cross midnight (`22:00`-`06:00`), and `start` may not equal
  `end`. Heartbeats are sent only inside active hours. Prechecks, changes, and renewals are not
  restricted by active hours.

Responses: `201 {"installId": "..."}` when created; `200 {"installId": "..."}` when the same
`installId` and `installSecret` are repeated (safe to retry, updates the fields above and
re-enables the install); `409` if the `installId` exists with a different secret.

Rate limit: 20 registration attempts per client network per hour (IPv4 address or IPv6 /64).
New installs are also capped overall per hour; an install that is already registered can always
register again.

### 3.2 Update: `PUT /v1/installations/{installId}`

Body: `apnsToken`, `environment`, and `heartbeat` exactly as in 3.1. Returns `204`. Call this on
every app launch and whenever the APNs token, time zone, or heartbeat preference changes. It
re-enables an install that APNs disabled.

### 3.3 Delete: `DELETE /v1/installations/{installId}`

Returns `204`. Deletes the install, its alarm triggers, and all its subscription mappings. Call
it when the user turns off background refresh or signs out of every provider, after stopping the
provider subscriptions.

### 3.4 Alarm triggers: `PUT /v1/installations/{installId}/alarms`

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
- Send after every reconcile that changes armed alarms (app or NSE). Returns `204`.

### 3.5 Provider subscriptions

```text
PUT    /v1/installations/{installId}/subscriptions/google/{channelId}
DELETE /v1/installations/{installId}/subscriptions/google/{channelId}
PUT    /v1/installations/{installId}/subscriptions/microsoft/{subscriptionId}
DELETE /v1/installations/{installId}/subscriptions/microsoft/{subscriptionId}
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
  expiration) and returns `204`. At most 64 subscriptions per install (`409` beyond that).
  A subscription ID registered to a different install returns `409`.
- `DELETE` returns `204`, including when the mapping does not exist.

Provider setup the device must use:

- Google `events.watch`: `type: "web_hook"`, `address`: the Google webhook URL, `id`: a random
  UUID, `token`: at least 32 random bytes base64url-encoded (Google allows up to 256 characters).
  Google channels cannot be extended: to renew, create a new channel, `PUT` it, then stop the old
  channel and `DELETE` its mapping.
- Microsoft Graph subscriptions: `notificationUrl` and `lifecycleNotificationUrl`: the Graph
  webhook URL, `clientState`: at least 32 random bytes base64url-encoded (Graph allows up to 128
  characters). Renew with `PATCH` and `PUT` the new expiration.

## 4. Webhooks (server behavior)

Google (`POST` to the Google webhook):

1. Look up `X-Goog-Channel-ID`. Unknown or expired channel: `204`, no push.
2. `sha256(X-Goog-Channel-Token)` must equal the stored hash, else `403`.
3. `sha256(X-Goog-Resource-ID)` must equal the stored `resourceId` hash, else `204`, no push.
4. `X-Goog-Resource-State`: `sync` is acknowledged without a push; `exists` and `not_exists`
   record a change for the install. Other values are ignored. Bodies are never read.

Microsoft Graph (the Graph webhook):

- Validation: a `POST` (or `GET`) with `?validationToken=...` is answered `200` with the decoded
  token as `text/plain`.
- Notifications: `POST` with a `value` array (at most 1,000 items naming at most 100 distinct
  subscriptions, 1 MiB; larger batches get `400`). Each item is matched by
  `subscriptionId`; unknown subscriptions and items whose `sha256(clientState)` does not match
  are skipped. Items without `lifecycleEvent` and `missed` lifecycle events record a change.
  `reauthorizationRequired` and `subscriptionRemoved` request an immediate renew push. Multiple
  items for one install produce at most one push. The response is `202`.
- Expired subscriptions: change notifications for a subscription past its recorded
  `expiresAtMs` are skipped. Lifecycle events (`reauthorizationRequired`, `subscriptionRemoved`,
  `missed`) for it are still verified and routed, because Graph only sends them for a
  subscription it still knows (for example one the device renewed whose `PUT` never arrived).
  Each such renewal request produces one `renew` push, not the 6-hour retries of section 6.
  Expired mappings are kept for 7 days for this, and do not count against the 64-subscription
  limit.

Delivery:

- Google: a recorded change is sent immediately from the webhook request if the install may
  receive a push (section 6).
- Microsoft Graph expects an answer within about 3 seconds, and Cloud Run may throttle CPU once
  a response is sent, so the Graph webhook never calls APNs. In one Firestore transaction per
  install it records the change and renewal requests and, if a push may go out now, creates an
  `iosPushDispatches` document; then it answers `202`. The `deliverIosPushDispatch` function,
  triggered by that document, plans and sends the push under the same claim, coalescing and
  collapse rules as the scheduler, then deletes the document. At most one dispatch is created per
  install per 30 seconds, since a dispatch reads the install's current state when it runs.
- In both cases a change that cannot go out now stays pending in Firestore and the scheduler
  sends it as soon as coalescing allows. The same applies if a dispatch is lost, fails, or hits a
  transient APNs failure (the trigger is not retried; the scheduler is). Webhooks return success
  once the work is recorded and only return `500` when it could not be stored.

## 5. Push format

Every push is an APNs alert so iOS runs the NSE, including after force quit and in Low Power Mode.

APNs request headers:

| Header | Value |
| --- | --- |
| `apns-push-type` | `alert` |
| `apns-topic` | the app bundle ID (`APNS_TOPIC`) |
| `apns-priority` | `5` for `heartbeat`; `10` for `change`, `precheck`, `renew` |
| `apns-collapse-id` | `aot-sync` for every relay push (it was `aot-<installId>` before October 2026; the app removes delivered notifications with the old ID once) |
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
| `aot.v` | Payload version, currently `1` |
| `aot.kind` | `change`, `heartbeat`, `precheck`, or `renew`; `assistant` for the assistant connector's pushes, which add fields of their own ([assistant protocol](ASSISTANT_PROTOCOL.md#apns-iphone)) |
| `aot.provider` | `google` or `microsoft`; present on `change` and on `renew` when every subscription due for renewal belongs to one provider |
| `aot.at` | Server send time, epoch ms |

The payload never contains alarm IDs or times, subscription IDs, or calendar data.

NSE handling rules:

1. Every push, whatever its kind, means "sync now": fetch provider deltas, re-read EventKit,
   reconcile and arm alarms, then `PUT` the alarm snapshot if it changed. The server counts any
   accepted push as satisfying pending changes, heartbeats, and due prechecks.
2. `renew` also means: renew any provider subscription expiring within 24 hours, recreate any
   that were removed, and `PUT` the new mappings. The NSE should do this opportunistically on
   any wake as well; the push is a reminder, not the only trigger.
3. `provider` and `kind` are hints for ordering work within the NSE time budget, nothing more.
4. Unknown `aot.v` or `kind`, or a missing `aot`: treat as a plain sync.
5. Every push replaces the previous notification via the shared collapse ID and is passive, so
   the user sees one quiet entry. The NSE may rewrite the title/body but must deliver a
   notification. Assistant pushes without an alert of their own
   ([assistant protocol](ASSISTANT_PROTOCOL.md#push-messages)) use the same `aot-sync` collapse ID,
   so relay and assistant syncs share that one entry.

## 6. Scheduling and coalescing

`scheduleIosPushes` runs every minute. Each install stores `nextWakeAtMs`, the next time anything
could be due, and the scheduler only reads installs whose time has passed plus subscriptions whose
renewal is due. Installs also store `priorityWakeAtMs`, the next precheck or pending change; the
scheduler visits those installs first, so heartbeats and renewals can't delay them.

- Coalescing: at most one push per install per 2 minutes, counted from the last push APNs
  accepted. While a push is in flight the install is claimed (the claim expires after 2 minutes if
  the sender dies). After an APNs failure other than an invalid token, the install backs off for 1,
  2, 4, 8, 16, then 30 minutes; pending work is kept.
- When several things are due at once, one push is sent, chosen in this order: `precheck`,
  `change`, `renew`, `heartbeat`. Deferred work goes out at the next allowed time.
- Heartbeat: due when `intervalMinutes` have passed since the last accepted push of any kind (or
  since registration) and the local time is within active hours. A heartbeat is therefore skipped
  whenever another push went out recently.
- Prechecks: for each alarm, stages at T-20 and T-8 minutes. A stage is due from its start for 2
  minutes. A priority-10 push (`change`, `precheck`, `renew`) sent within the 2 minutes before a
  stage starts also satisfies it; a heartbeat due in that span is sent as a `precheck` instead. Each
  stage is sent at most once per trigger time.
- Renewal: a subscription becomes due 24 hours before `expiresAtMs`, or immediately after a Graph
  `reauthorizationRequired` / `subscriptionRemoved` (also after expiry, see section 4). After an
  accepted `renew` push the server asks again every 6 hours until the device `PUT`s a new
  expiration or the subscription expires.
- APNs `410`, or `400` with reason `BadDeviceToken`, disables the install (unless its token changed
  while the push was in flight). Disabled installs get no pushes until the app sends 3.1 or 3.2.
  Disabled installs are deleted after 30 days.

## 7. Versioning

- `aot.v` versions the push payload. Within v1, optional fields may be added; clients must ignore
  unknown fields. Changing the meaning of an existing field or kind requires `v: 2`. A new `kind`
  value is allowed within v1 because rule 4 above makes clients treat it as a sync.
- The device API is versioned by path (`/v1/...`). Within v1 the server will not add required
  request fields or remove response fields. Incompatible changes get a `/v2` route, served
  alongside `/v1` until old app versions are retired.

## 8. Server configuration

| Name | Kind | Purpose |
| --- | --- | --- |
| `APNS_AUTH_KEY_P8` | Secret Manager secret | APNs token-auth `.p8` key (EC P-256, PEM) |
| `APNS_KEY_ID` | string param | 10-character key ID |
| `APNS_TEAM_ID` | string param | 10-character Apple team ID |
| `APNS_TOPIC` | string param | App bundle ID |
| `IOS_PUSH_ENFORCE_APP_CHECK` | boolean param, default `true` | Require App Check for registration |

APNs uses token-based authentication: an ES256 JWT (`kid` = key ID, `iss` = team ID, `iat`)
reused for 40 minutes over a pooled HTTP/2 connection per APNs environment.

Firestore collections (`iosPushInstalls`, `iosPushSubscriptions`, `iosPushRateLimits`,
`iosPushDispatches`) are written only by the functions through the Admin SDK; client rules deny
all access. Registration rate-limit documents are keyed by an unsalted `sha256` of the client
network, which is not plaintext but is guessable for IPv4; they hold only a count and are deleted
by the scheduler once the hour-long window ends. Subscription mappings are deleted 7 days after
they expire. Dispatch documents hold an install ID and hashed subscription document IDs; the
trigger deletes them, and the scheduler prunes any left after an hour.

Functions: `iosPushApi`, `iosGoogleWebhook` and `iosMicrosoftWebhook` (HTTPS), `scheduleIosPushes`
(every minute), and `deliverIosPushDispatch` (Firestore `onDocumentCreated` on
`iosPushDispatches/{dispatchId}`, region `us-central1`, not retried). The APNs secret is bound to
the Google webhook, the scheduler and the dispatch trigger, and, for the assistant connector's
iPhone pushes ([assistant protocol](ASSISTANT_PROTOCOL.md#push-messages)), to `assistantMcp` and
`undoAssistantChange`. The key and params are declared once, in
[`functions/apns-config.js`](../functions/apns-config.js).

Because the codebase now declares these params and the secret, expect any functions deploy from
it, including one that only updates the feedback trigger, to prompt for or require them. Create
them before the next functions deploy.

# Assistant connector

A remote [MCP](https://modelcontextprotocol.io) server that lets Claude or ChatGPT read and change
a user's Always On Time alarm settings. It never reads or changes a calendar: the phone shares a
summary of upcoming events and alarms, and the connector writes alarm settings into the same
account-sync records the app already uses. The phone/server/Firestore contract is
[ASSISTANT_PROTOCOL.md](ASSISTANT_PROTOCOL.md).

Code: [`functions/assistant-*.js`](../functions/assistant-functions.js), consent page
[`account-web/connect/`](../account-web/connect/index.html), App Link fallback
[`account-web/open/`](../account-web/open/index.html).

## Endpoints

All on `https://alwaysontime.zombit.io` (Hosting rewrites to the functions):

| Path | Function | Purpose |
| --- | --- | --- |
| `POST /mcp` | `assistantMcp` | MCP Streamable HTTP, stateless JSON responses. Bearer token required; a 401 points to the metadata below. |
| `GET /.well-known/oauth-protected-resource[/mcp]` | `assistantOauth` | RFC 9728 resource metadata |
| `GET /.well-known/oauth-authorization-server` | `assistantOauth` | RFC 8414 server metadata |
| `POST /oauth/register` | `assistantOauth` | Dynamic client registration (RFC 7591) |
| `GET /oauth/authorize` | `assistantOauth` | Starts a request and redirects to the consent page |
| `POST /oauth/consent`, `POST /oauth/approve` | `assistantOauth` | Used by the consent page |
| `POST /oauth/token` | `assistantOauth` | Code and refresh token exchange |
| `POST /oauth/revoke` | `assistantOauth` | RFC 7009 revocation (revokes the whole connection) |
| `/connect/` | Hosting | Consent page: Google sign-in, what the assistant can see and change, Approve/Cancel |
| `/open/**` | Hosting | Fallback for App Links when the app is not installed |
| `/.well-known/assetlinks.json` | Hosting | Android App Links verification |

Hosting also serves these paths on the project's default domains
(`always-on-time-zombit-2026.web.app` and `.firebaseapp.com`, recognized by `X-Forwarded-Host`).
There the OAuth and discovery paths answer `308` to the same path and query on the custom domain,
which keeps the method and body. `/mcp` answers `410` with a JSON-RPC error naming the new URL
instead of redirecting: clients drop the bearer token when a redirect changes host, and a token or
resource indicator for the old URL is not valid here, so the assistant has to add the connector
again. The emulators skip this.

The app calls `listAssistantConnections`, `revokeAssistantConnection` and `undoAssistantChange`
(the activity log's Undo, with the same checks as the `undo` tool) (callable functions;
Google sign-in and an active synced account required). `listAssistantConnections` returns
`{connections: [{grantId, clientName, assistant, verified, clientHost, scopes, createdAt,
lastUsedAt, setupConfirmedAt}]}`, most recently used first: `assistant` is `claude`, `chatgpt` or
`other`, `clientName` is "Unverified app" unless `verified`, `clientHost` is the host the
connection's codes went to (null for connections made before it was recorded), and times are epoch
ms or null. `pruneAssistantConnections` runs daily and
`sendAssistantUsageSummary` posts anonymous weekly totals to the developer's Discord channel.

## OAuth

OAuth 2.1 with PKCE (S256 only), scopes `alarms.read alarms.write`, and the `iss` response
parameter (RFC 9207).

- Clients register either with a Client ID Metadata Document (an `https` URL as `client_id`) or
  with dynamic registration. Metadata documents are fetched with SSRF guards: https on the default
  port, a host name (not an IP), every resolved address public, no redirects, 5 KB and 5 s limits.
  They are cached for a day. Only `/oauth/authorize` fetches one; the token and revoke endpoints
  use the stored client and reject unknown ones. A failed fetch is remembered for 10 minutes, and
  fetches are capped per host and overall.
- Only Claude and ChatGPT are named, and only when their `client_id` is a metadata document on
  their own host: `claude.ai` (Claude) or `chatgpt.com` (ChatGPT), exactly. Every other client,
  including any dynamically registered one, whatever `client_name` it declares, is shown as
  "Unverified app" together with the host its codes are sent to (`clientHost`, the redirect URI's
  host). The consent page warns about unverified apps.
- Errors and cancellation redirect back only to a verified client. For an unverified client, a bad
  authorization request shows an error page and Cancel shows "Cancelled", so the endpoint can't be
  used as an open redirect.
- Redirect URIs must match exactly; `http` is allowed only for loopback hosts, where the port may
  differ.
- The consent page asks the user to sign in with the Google account they use in the app. Approval
  works only for an account that has turned on account sync.
- Tokens are random and opaque; only their SHA-256 hashes are stored. Access tokens last 1 hour,
  refresh tokens 90 days and rotate on every use. Reusing a spent authorization code or refresh
  token within 30 seconds is refused (`invalid_grant`) without other effect, which covers a client
  retrying a lost response; reusing it later revokes the connection.
- A connection (grant) is created when the code is exchanged. Connecting the same assistant again
  replaces its earlier connection. Connections idle for 90 days are removed.
- Disconnecting the last assistant deletes the shared snapshot, device and activity documents.
  Deleting the account removes every connection first.

## Tools

| Tool | What it does |
| --- | --- |
| `get_status` | Connected phones, snapshot age, pause state, capabilities, whether setup is confirmed |
| `list_upcoming_alarms` | Alarms that will ring in a time range (default next 24 h), in ring order |
| `find_events` | Searches event titles in the next 30 days; returns keys and alarms |
| `explain_alarm` | Why an event rings when it does (occurrence, series, calendar, app default or travel) |
| `list_calendars` | Every calendar on the phone with its alarm settings |
| `get_settings` | App-wide alarm, snooze, spoken-alarm and appearance settings |
| `get_alarm_history` | What happened to alarms in the last 1–14 days |
| `set_event_alarms` | Lead times for one occurrence, off, or reset |
| `set_series_alarms` | Lead times for every occurrence of a recurring event, off, or reset |
| `set_calendar` | Watch a calendar or not, its lead times, invitation filter, whether it rings through Do Not Disturb (all-day events are an app-wide setting) |
| `update_settings` | App-wide settings |
| `pause_alarms` / `resume_alarms` | Pause every alarm until a time or until resumed |
| `undo` | Reverses an earlier change from the last 30 days unless those settings changed since |
| `confirm_change` | Waits for the phones to apply a change and reports which did |
| `test_connection` | Setup check: sends a test notification to each phone and reports which received it |
| `refresh` | Asks the phones for a fresh snapshot and waits for it |
| `open_in_app` | A link that opens a screen of the app (sounds, permissions, Plus and so on) |

Each change writes the new `values` records and an activity entry atomically, then sends the
phones an FCM `sync` message. Write tools return a `changeId` for `confirm_change` and `undo`. Once
the change is saved, a failure to notify the phones doesn't make the call fail: it returns the
`changeId` with a note that the phone will pick the change up on its next sync. Tools that can
stop alarms from ringing (pausing, turning alarms off, unwatching a calendar, quieter settings)
are annotated `destructiveHint: true`, and the server instructions tell the assistant to confirm
them with the user first. Event titles and calendar names are third-party text (anyone can send an
invitation): they are cleaned, quoted in tool output, and the instructions say never to follow
instructions in them. Live traffic for travel alarms needs Plus benefits; the connector only
explains that and links to the app.

### Rate limits

| Limit | Where counted | Applies to |
| --- | --- | --- |
| Per caller: register 30/h, authorize 60, consent 120, approve 30, token and revoke 120 per 10 min | Firestore, shared | OAuth endpoints |
| Per network hop: 300 per 10 min | memory, per instance | OAuth endpoints |
| Overall: authorize 300, consent and approve 600, token and revoke 600 per 10 min; registrations 500/h (Firestore) | memory, per instance | OAuth endpoints |
| Metadata document fetches: 20 per host, 100 overall per 10 min | memory, per instance | `/oauth/authorize` |
| Tool calls: 120 per connection per 10 min; pushes 40 per connection per 10 min | memory; Firestore | `/mcp` |
| Calls without a valid token: 30 per caller, 600 overall per minute, checked before any database read | memory, per instance | `/mcp` |

In-memory limits hold per instance; with at most 10 instances they hold at ten times their value
overall. Callers are identified as follows. Google's front end appends the connecting address to
`X-Forwarded-For`, so its last entry (the hop) can't be forged: for a direct call to the
function's own URL it is the caller, and through Hosting it is the CDN, shared by many users. The
per-caller key is `Fastly-Client-IP` (the visitor as Hosting's CDN reports it), else the hop; a
direct caller can forge it, so it only keeps one honest client from using up the shared budget.
No header identifies a person reliably here, so the overall caps are what bound abuse.

## What is stored

| Data | Where | Lifetime |
| --- | --- | --- |
| Snapshot of upcoming events and alarms (titles, times, calendar names), device model label, FCM token | `accounts/{uid}/assistantSnapshots`, `assistantDevices` (at most 10 phones; older ones are removed) | Until the last assistant disconnects, sign-out or account deletion |
| Change log (summary, before/after settings) | `accounts/{uid}/assistantActivity` | 30 days, or until the last assistant disconnects |
| Connection: assistant name, whether it is verified, the host its codes go to, scopes, created/last used, the account's `logId` | `oauthGrants` | Until revoked, or 90 days idle |
| `logId`: a random pseudonym that names the account in request logs | `accounts/{uid}/assistant/log` | Until account deletion |
| Token and code hashes | `oauthTokens`, `oauthCodes`, `oauthRequests` | Expiry (TTL) |
| Registered assistant clients (public metadata) | `oauthClients` | 90 days unused (TTL) |
| Rate limit counts (document ID is a hash of the connection or IP and the time window) | `assistantRateLimits` | About an hour (TTL) |
| Anonymous daily totals: connections, tool calls and errors, setup tests, undos | `assistantUsage` | Kept; no user identifiers |
| Request logs: action, the account's `logId` (never its uid or email), random ids (grant, change, request, ping, record, device), outcome, duration | Cloud Logging `_Default` bucket | 30 days; account deletion deletes the `logId` and the records those ids pointed to, so remaining entries can't be tied to the person |

The Google account email is read from Firebase Auth only to match Google Calendar IDs to calendar
keys; it is not stored or given to the assistant.

The [privacy policy](PRIVACY_POLICY.md) and Play's Data safety answers need to cover this table,
including that what an assistant reads then falls under its provider's policy, before the
connector is offered in the app.

## Debugging

Every connector action writes one structured line through `firebase-functions`' logger
([`assistant-log.js`](../functions/assistant-log.js)), so each field is a `jsonPayload` field in
Cloud Logging. `assistantEvent` names the action.

Entries name the account by `logId` (`log_` and 16 random characters), never by the Firebase uid or
an email address. The account's first assistant connection creates it in
`accounts/{uid}/assistant/log` and copies it onto each connection (`oauthGrants`), so logging needs
no extra read; it is the same across reconnects. Account deletion deletes that document and the
connections, after which nothing links the account's entries (kept for the bucket's retention) to
it. Cloud Logging can't delete single entries, which is why the uid is never written. Error messages
are logged with `accounts/<uid>` paths and email addresses replaced.

| `assistantEvent` | Fields besides `logId` |
| --- | --- |
| `tool.call` | `tool`, `outcome` (`ok`, `no_phone`, `tool_error`, `unexpected_error`), `durationMs`, `grantId`, `client`, and when they apply `changeId`, `undoneChangeId`, `recordIds`, `requestId`, `pingId`, `status`, `push` (`{type, devices: [{deviceId, result, errorCode}]}`) |
| `oauth.client_metadata`, `oauth.register` | CIMD fetch or DCR registration (no `logId`): `clientId`, `client`, `outcome`, `reason` |
| `oauth.authorize`, `oauth.consent` | `clientId`, `outcome` (`consent`, `approved`, `denied`, or an error code); only `oauth.consent` `approved` has a `logId` |
| `oauth.code_exchange`, `oauth.refresh`, `oauth.revoke` | `grantId`, `clientId`, `outcome`, `reason` when refused, `replacedGrantIds`, `revokedGrantId`; `oauth.revoke` has only the `grantId` |
| `oauth.token_rejected`, `oauth.error` | `reason` or `errorCode` only |
| `connection.revoked`, `prune` | `grantId`, `reason` (`app`, `client`, `idle`, `code_reuse`, `refresh_reuse`), `remaining` / `revoked` |
| `callable.undo`, `callable.list_connections`, `callable.revoke_connection` | as `tool.call`, or `count` / `revoked` |
| `push.failed`, `push.invalid_token_removed`, `push.state_failed` | `deviceId`, `type`, `errorCode` |
| `push.after_commit_failed` | A change was saved but reading devices or pushing failed: `changeId`, `errorCode` |
| `grant.touch_failed`, `oauth.client_touch_failed` | Updating a connection's or client's last-used time failed: `grantId` or `clientId`, `errorName`, `errorCode` |
| `grant.log_id_failed` | A connection made before logIds existed couldn't get one; its request went ahead without: `grantId`, `errorCode` |
| `account_emails_failed` | Reading the account's emails (to match Google Calendar IDs) failed: `errorCode` |

The helper writes only an allowlist of fields: never event titles, summaries, settings payloads,
tool arguments, tokens, codes, PKCE values, redirect URIs, emails or uids. Tool errors log their outcome,
not their message (it can quote a title).

The phone logs the same ids with an `Assistant:` prefix (the app's `docs/ASSISTANT_MCP.md`
"Debugging"), and feedback can attach the last 24 hours of that log. To follow an action end to
end, take an id from the feedback log and filter Logs Explorer in `always-on-time-zombit-2026`:

```
jsonPayload.changeId="ch_…" OR jsonPayload.undoneChangeId="ch_…"
jsonPayload.requestId="req_…"
jsonPayload.pingId="ping_…"
jsonPayload.push.devices.deviceId="<deviceId>" OR jsonPayload.deviceId="<deviceId>"
jsonPayload.logId="log_…" AND jsonPayload.assistantEvent:*
```

To find a user's entries from their account, look up the `logId` in Firestore at
`accounts/{uid}/assistant/log` (or on any of their `oauthGrants` documents) and filter on it as
above. Accounts that have never connected an assistant have no `logId`. Once the account is deleted
there is nothing to look up, which is the point.

Logs stay in the `_Default` bucket for its 30-day retention.

## Local testing

The unit tests run with `npm test`; the emulator suites are in the [README](../README.md#tests).
To try the server with [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```sh
printf 'APNS_AUTH_KEY_P8=x\nFEEDBACK_DISCORD_WEBHOOK_URL=http://127.0.0.1:9/\nTOMTOM_API_KEY=x\nTRAVEL_ROUTE_API_KEY=x\n' > functions/.secret.local
cp functions/.env.always-on-time-zombit-2026 functions/.env.local
echo 'ASSISTANT_ORIGIN=http://127.0.0.1:5012' >> functions/.env.local
npx firebase emulators:start --only auth,firestore,functions,hosting --project demo-account-sync
npx @modelcontextprotocol/inspector
```

In Inspector choose Streamable HTTP and `http://127.0.0.1:5012/mcp`, then connect. The consent page
signs in through the Auth emulator; create `accounts/{uid}` with `active: true, schemaVersion: 1`
in the Emulator UI so the account counts as set up. Without a phone, tools report that no phone has
shared its alarms; [`functions/testing/assistant-e2e.cjs`](../functions/testing/assistant-e2e.cjs)
shows how to write a device and snapshot to stand in for one. In the emulator, FCM messages are
logged instead of sent.

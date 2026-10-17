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

All on `https://always-on-time-zombit-2026.web.app` (Hosting rewrites to the functions):

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

The app calls `listAssistantConnections`, `revokeAssistantConnection` and `undoAssistantChange`
(the activity log's Undo, with the same checks as the `undo` tool) (callable functions;
Google sign-in and an active synced account required). `pruneAssistantConnections` runs daily and
`sendAssistantUsageSummary` posts anonymous weekly totals to the developer's Discord channel.

## OAuth

OAuth 2.1 with PKCE (S256 only), scopes `alarms.read alarms.write`, and the `iss` response
parameter (RFC 9207).

- Clients register either with a Client ID Metadata Document (an `https` URL as `client_id`) or
  with dynamic registration. Metadata documents are fetched with SSRF guards: https on the default
  port, a host name (not an IP), every resolved address public, no redirects, 5 KB and 5 s limits.
  They are cached for a day.
- Redirect URIs must match exactly; `http` is allowed only for loopback hosts, where the port may
  differ.
- The consent page asks the user to sign in with the Google account they use in the app. Approval
  works only for an account that has turned on account sync.
- Tokens are random and opaque; only their SHA-256 hashes are stored. Access tokens last 1 hour,
  refresh tokens 90 days and rotate on every use. Reusing a spent refresh token or authorization
  code revokes the connection (a short grace period covers a client retrying a lost response).
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
| `set_calendar` | Watch a calendar or not, its lead times, invitation filter, all-day events |
| `update_settings` | App-wide settings |
| `pause_alarms` / `resume_alarms` | Pause every alarm until a time or until resumed |
| `undo` | Reverses an earlier change from the last 30 days unless those settings changed since |
| `confirm_change` | Waits for the phones to apply a change and reports which did |
| `test_connection` | Setup check: sends a test notification to each phone and reports which received it |
| `refresh` | Asks the phones for a fresh snapshot and waits for it |
| `open_in_app` | A link that opens a screen of the app (sounds, permissions, Plus and so on) |

Each change writes the new `values` records and an activity entry atomically, then sends the
phones an FCM `sync` message. Write tools return a `changeId` for `confirm_change` and `undo`.
Live traffic for travel alarms needs Always On Time Plus; the connector only explains that and
links to the app. Calls are rate limited per connection and per IP.

## What is stored

| Data | Where | Lifetime |
| --- | --- | --- |
| Snapshot of upcoming events and alarms (titles, times, calendar names), device model label, FCM token | `accounts/{uid}/assistantSnapshots`, `assistantDevices` | Until the last assistant disconnects, sign-out or account deletion |
| Change log (summary, before/after settings) | `accounts/{uid}/assistantActivity` | 30 days, or until the last assistant disconnects |
| Connection: assistant name, scopes, created/last used | `oauthGrants` | Until revoked, or 90 days idle |
| Token and code hashes | `oauthTokens`, `oauthCodes`, `oauthRequests` | Expiry (TTL) |
| Registered assistant clients (public metadata) | `oauthClients` | 90 days unused (TTL) |
| Rate limit counts (document ID is a hash of the connection or IP and the time window) | `assistantRateLimits` | About an hour (TTL) |
| Anonymous daily totals: connections, tool calls and errors, setup tests, undos | `assistantUsage` | Kept; no user identifiers |

The Google account email is read from Firebase Auth only to match Google Calendar IDs to calendar
keys; it is not stored or given to the assistant.

The [privacy policy](PRIVACY_POLICY.md) and Play's Data safety answers need to cover this table,
including that what an assistant reads then falls under its provider's policy, before the
connector is offered in the app.

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

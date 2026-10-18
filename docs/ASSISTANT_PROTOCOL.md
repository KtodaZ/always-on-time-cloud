# Assistant connector protocol

The contract between the phone app, the assistant connector (MCP server) and Firestore. The
product design lives in the app repository; this file is what both sides must agree on. Android
implements it first. iOS can use the same Firestore contract, but pushes are FCM-only today: iOS
needs an APNs push path in [`functions/assistant-push.js`](../functions/assistant-push.js).

[`assistant-protocol-vectors.json`](assistant-protocol-vectors.json) holds the shared test
vectors (record keys, canonical payloads, preference allowlists). The server's tests and the app's
tests both assert against it, so a contract change starts there.

Nothing here exists for a user until they connect an assistant. Disconnecting the last assistant
deletes everything under "Connector data" below.

## Firestore layout

Existing account sync: `accounts/{uid}` (`active`, `schemaVersion`),
`accounts/{uid}/values/{recordId}` (`payload` string; the rules accept only the record ids under
"Record keys and payloads") and `accounts/{uid}/history/{id}` (the newest 5,000 per account are
kept; creating more deletes the oldest by `createdAt`). Values the
connector writes also carry `updatedAt`, a server timestamp from the same commit as the change's
`writtenAt` (the Android SDK doesn't expose `updateTime`). Phones write `payload` only, which drops it.

Connector data:

| Path | Written by | Read by | Content |
| --- | --- | --- | --- |
| `accounts/{uid}/assistant/state` | server | owner | `connected` (bool), `connections` (int), `updatedAt` (timestamp) |
| `accounts/{uid}/assistant/log` | server | server | `logId`: the pseudonym that names the account in request logs (no client access) |
| `accounts/{uid}/assistantDevices/{deviceId}` | owner | owner, server | see Devices |
| `accounts/{uid}/assistantSnapshots/{deviceId}` | owner | owner, server | see Snapshot |
| `accounts/{uid}/assistantActivity/{changeId}` | server | owner | see Activity |
| `oauthClients/{hash}`, `oauthRequests/{hash}`, `oauthCodes/{hash}`, `oauthGrants/{grantId}`, `oauthTokens/{hash}` | server | server | OAuth state (no client access) |
| `assistantRateLimits/{hash}` | server | server | rate limit counts with a TTL (no client access) |
| `assistantUsage/{yyyy-mm-dd}` | server | server | anonymous daily counters (no client access) |

`deviceId` is a random UUID the phone creates once per install and per account (not an Android
ID). The owner is the signed-in Google account `uid` with an active account, as for `values`.

### Devices

`accounts/{uid}/assistantDevices/{deviceId}`:

| Field | Type | Notes |
| --- | --- | --- |
| `platform` | `"android"` \| `"ios"` | |
| `deviceName` | string ≤ 100 | Model label, e.g. "Pixel 9" (same label as synced history) |
| `appVersion` | string ≤ 40 | |
| `fcmToken` | string ≤ 4096 of `A-Z a-z 0-9 _ - :` | Android; absent on iOS until its relay is wired |
| `capabilities` | list of strings ≤ 20 | Only `travel`, `spokenAlarms`, `plus` (the phone has Plus benefits, whether bought or free for a limited time), `pause` (the rules reject others, so a new capability needs a rules change first) |
| `lastPing` | map | `{id: string ≤ 64, receivedAt: timestamp}` echo of the latest test ping |
| `updatedAt` | timestamp | `request.time` |

A phone writes this only while `assistant/state.connected == true`, and deletes it when the flag
turns false, on sign-out, and before account deletion. An account keeps at most 10 device and 10
snapshot documents: creating more deletes the least recently updated. The server pushes to at most
the 10 most recently updated devices and parses only the most recently published snapshot. While
waiting for phones (`confirm_change`, `refresh`) it polls only the snapshots' `publishedAt` and
`requestId`, and reads a payload again only after its phone published a new one (for
`valuesAppliedThrough`, found without parsing the rest).

### Snapshot

`accounts/{uid}/assistantSnapshots/{deviceId}` has four fields: `schemaVersion` (1),
`publishedAt` (timestamp, `request.time`), `requestId` (string ≤ 64 or absent, echo of the
publish request that caused it) and `payload` (JSON string ≤ 800,000 characters; the phone drops
its furthest events until it fits, and the server never parses a longer one):

```json
{
  "device": "Pixel 9",
  "builtAt": 1793119990000,
  "timeZone": "America/Los_Angeles",
  "valuesAppliedThrough": 1793120000000,
  "windowEnd": 1795712000000,
  "paused": {"until": 0},
  "calendars": [
    {"key": "c_…", "name": "Work", "accountType": "com.google", "watched": true,
     "leadTimes": [10, 0], "enabled": true, "rsvpFilter": "not_declined", "includeAllDay": false}
  ],
  "events": [
    {"eventKey": "e_…", "seriesKey": "s_…", "calendarKey": "c_…", "title": "Standup",
     "start": 1793124000000, "end": 1793124900000, "allDay": false, "recurring": true,
     "rsvp": "ACCEPTED",
     "alarms": [
       {"at": 1793123400000, "kind": "lead", "minutes": 10, "source": "series", "status": "on"},
       {"at": 1793122800000, "kind": "travel", "minutes": 0, "source": "travel", "status": "on"}
     ]}
  ]
}
```

- `builtAt`: when the phone built the snapshot (epoch ms). Snapshot age uses it (capped at
  `publishedAt`), so a snapshot built offline and uploaded later reads as old; without it the
  server uses `publishedAt`.
- `valuesAppliedThrough`: the greatest `updatedAt` (ms) among `values` documents the phone has
  applied, never lowered. A connector change is confirmed when this is ≥ the change's write time.
- `calendars`: every calendar on the phone, watched or not. `key` is null for calendars without a
  portable identity (local-only); such calendars are listed but cannot be changed remotely.
  A name that is an email address (a primary calendar is named after its account) is shared as
  `Google calendar (example.com)` for Google calendars or `Calendar (example.com)` otherwise,
  keeping only the domain. `rsvpFilter` is the storage value: `accepted_only`,
  `accepted_or_tentative`, `not_declined` or `all_events` (the server also accepts older phones'
  upper-case names). `leadTimes`, `enabled`, `rsvpFilter` and `includeAllDay` are the calendar's
  effective settings and may be absent.
- `events`: watched calendars, after the app's filters, from now until `windowEnd` (30 days).
  Events filtered out by RSVP or all-day settings are omitted. `eventKey`/`seriesKey` are null when
  the event has no portable identity.
- `rsvp`: `ACCEPTED`, `TENTATIVE`, `DECLINED`, `INVITED`, `NONE`, `ORGANIZER`, or absent.
- `alarms[].kind`: `lead` (minutes before start) or `travel` (minutes before leaving).
  `source`: `app`, `calendar`, `series`, `event` or `travel`. `status`: `on`, `off` (alarm disabled
  for the event), `paused` (inside a pause window), or `past`.
- The server drops fields it doesn't know and values outside these lists, and treats titles and
  names as untrusted text: it strips control, format and bidirectional characters and other
  invisible ones (variation selectors, tag characters, fillers), collapses whitespace and cuts them
  at 200 characters.
- Never included: descriptions, attendees, locations, meeting links, travel origins or
  destinations, sound or voice choices.

### Activity

`accounts/{uid}/assistantActivity/{changeId}` (server-written, 30-day TTL on `expiresAt`):
`assistant` (client display name), `tool`, `summary` (plain-language, may contain an event title),
`records` (map of recordId → `{before: string|null, after: string|null}` payloads), `writtenAt`
(server timestamp written in the same commit as the `values`, so it equals their `updatedAt`),
`alert` (absent, or why the app should highlight the entry), `undoneAt` (timestamp or absent),
`expiresAt` (timestamp).

`alert` marks changes that could stop alarms from ringing or being heard, checked in this order:

| `alert` | When |
| --- | --- |
| `paused` | `p_alarms_paused_until` set to −1 or a time |
| `calendar_unwatched` | a `c_` record's `selected` becomes false |
| `alarms_off` | a `c_` record's `overrides.enabled`, or an `s_`/`e_` record's `enabled`, becomes false |
| `alerts_reduced` | `alarm_volume` set to 20 or less and lower than before (unset counts as 80), `alert_type` lowered (`sound_and_vibration` > `vibration_only` > `visual_only`), `vibration_enabled` set to false while the alert type is `vibration_only`, `respect_dnd` turned on, `override_system_volume` turned off (from true), or a calendar's `ringThroughDnd` turned off |
| `alarms_filtered` | `rsvp_filter`, or a calendar's `rsvpFilter`, becomes `accepted_only`; `ignore_all_day_events` (from false) or a calendar's `ignoreAllDay` becomes true |
| `alarms_shortened` | `alarm_duration_seconds` set to 1–15 and shorter than before (unset counts as 60, 0 rings until dismissed) |
| `alarms_early` | a lead time over 1,440 minutes (a day) added to an event, series or calendar (`leadTimes` or `addedLeadTimes`) or to the app default (`default_lead_times_csv`, `default_lead_time_minutes`) |

Phones show any `alert` (an unknown value gets generic wording) with an undo action, so a new value
needs no app change.

## Record keys and payloads

Keys are lowercase hex SHA-256 with a prefix. `json(list)` is a compact JSON array with no spaces
and no escaping beyond JSON's required escapes (kotlinx `Json.encodeToString(listOf(...))`).

- Calendar: `c_` + sha256(json([accountType, accountName, calendarName])). For Google calendars on
  Android, `accountType` is `com.google`, `accountName` is the Google account email and
  `calendarName` is the Google calendar ID. Local calendars have no key.
- Series: `s_` + sha256(json([calendarKey, syncId])), where `syncId` is the provider event ID of
  the series (for a Google exception, its original series ID).
- Occurrence: `e_` + sha256(`{seriesKey}:{originalStartMillis}`) for recurring events, or
  `e_` + sha256(`{seriesKey}:single`) for single events.
- Preferences: `p_{name}` from the allowlist below.

Test vectors (both implementations must reproduce them; also in the vectors file):

| Input | Key |
| --- | --- |
| calendar `["com.google","alex@example.com","alex@example.com"]` | `c_42fb4c3a3db8d2bba3e4897484575c76b2c03322bddf69f7dfcd787a6c213d5a` |
| calendar `["com.google","alex@example.com","en.usa#holiday@group.v.calendar.google.com"]` | `c_fee33e5026cd74ede2b023b984a72453b4d16a166b50e29d92fdd0af1c561ec9` |
| series `[<first calendar>,"4kq0l1v3s9example"]` | `s_050961489e18b374331b1996aed77c48ac038669dd77a00357129ece44535a7d` |
| single occurrence of that series | `e_e41735eed816bc24db9dc5b08d92ac12b112a12a4600a6ede42faf14cf6df08d` |
| series `[<first calendar>,"7rcurring0example"]` | `s_a4b8d08d97e8a3a8fd964c4e1811abafeb4c2ae465c396f6b6debbbf06929e5f` |
| that series' occurrence at `1793124000000` | `e_7b1ec89029a39d5b40d6ffb94cb7187192ac341db9b4f614b97fae4fc623abda` |

Payloads (`values/{key}.payload`, ≤ 16 KB):

- `c_`: `{"selected": bool, "overrides": Override}`, each optional
- `s_`, `e_`: `Override` JSON, or the string `null` to clear the rule or override.
- `Override`: `leadTimes` (≤ 20 ints in −1440..10080), `enabled` (bool), `volume` (0..100),
  `vibrationPattern` (≤ 100 chars), `ignoreAllDay` (bool, calendars), `rsvpFilter` (≤ 100 chars,
  calendars), `addedLeadTimes` (≤ 20 ints), `travelLeadTimes` (1..4 ints in 0..179, calendars; the app's per-event alarm limit and
  longest travel lead), `ringThroughDnd` (bool, calendars, Android only: the calendar's alarms
  ring with sound during Do Not Disturb while `respect_dnd` is on; only `true` is written, absent
  means off). Absent fields mean "inherit". Phones ignore unknown fields; the server
  validates only the fields it knows and keeps unknown ones when it rewrites a record, so a newer
  app's fields survive an assistant change.
- `p_`: JSON scalars (`null` clears). Booleans: `dynamic_color`, `apply_accent_to_app`,
  `vibration_enabled`, `gradual_volume_enabled`, `spoken_alarm_include_event_name`,
  `spoken_alarm_include_time_until_event`, `spoken_alarm_include_location`,
  `spoken_alarm_include_helpful_reminder`, `respect_dnd`, `override_dnd_for_priority`,
  `ignore_all_day_events`, `auto_detect_meeting_urls`, `override_system_volume`,
  `smart_snooze_suggestions`. `override_dnd_for_priority` is retired (replaced by the calendar
  override `ringThroughDnd`): it stays allowed so older phones' records validate, but nothing reads
  it and the assistant neither shows nor changes it. Integers: `default_lead_time_minutes`
  0..10080, `alarm_volume` 0..100, `snooze_duration_minutes` 1..1440, `alarm_duration_seconds` 0..86400, `max_snoozes`
  0..100, `spoken_alarm_speech_rate_hundredths` 25..400. Strings (≤ 500): `theme_preference`
  (`system`, `light`, `dark`), `accent_id`, `default_lead_times_csv` (a JSON list, e.g. `[0,10]`),
  `alert_type` (`sound_and_vibration`, `vibration_only`, `visual_only`), `vibration_pattern`,
  `spoken_alarm_meeting_type_preference` (`enabled`, `disabled`), `spoken_alarm_repetition`
  (`never`, `after_15_seconds`, `after_30_seconds`, `after_1_minute`, `after_2_minutes`, and the
  older `once`, `automatic`), `rsvp_filter` (`accepted_only`, `accepted_or_tentative`,
  `not_declined`, `all_events`); the others take any string. Long: `alarms_paused_until`
  (0 = not paused, −1 = until resumed, otherwise epoch ms ≤ 4102444800000).

Canonical encoding: payloads are written the way kotlinx serialization writes the app's data
classes. Fields appear in the data class's order (`leadTimes`, `enabled`, `volume`,
`vibrationPattern`, `ignoreAllDay`, `rsvpFilter`, `addedLeadTimes`, `travelLeadTimes`,
`ringThroughDnd`; `selected`, `overrides`), null fields are left out, lead-time lists are sorted
ascending without duplicates, and there are no spaces. So `c_` with only `selected` is
`{"selected":true}`. Unknown fields follow the known ones. Equal meaning, not equal text, is what
counts: comparisons (skipping a change that changes nothing, undo's "changed since" check) parse
both payloads and compare their canonical forms.

The server validates every write against these limits before writing; phones validate again on
apply.

## Push messages (FCM, data-only, high priority)

| `type` | Other fields | Phone does |
| --- | --- | --- |
| `sync` | `changeId` | Pull `values`, apply, reschedule, publish a snapshot |
| `publish` | `requestId` | Publish a snapshot with that `requestId` |
| `ping` | `pingId`, `assistant` (display name ≤ 60) | Post the "connected" notification and write `lastPing` |
| `state` | — | Re-read `assistant/state` (connection added or removed) |

Phones must treat every message as a hint: verify the signed-in account, read Firestore for the
actual data, and do nothing that a forged message could abuse. A phone publishes at most one
snapshot per 10 seconds; extra requests coalesce.

## Connection lifecycle

1. Exchanging an approved authorization code creates the grant, sets `assistant/state` to
   connected and updates `connections`. Connecting the same assistant again replaces its earlier
   grant; grants unused for 90 days are revoked by a daily job.
2. A signed-in phone sees the flag (live listener while the app runs, or the next periodic account
   sync), writes its device document with an FCM token, and publishes a snapshot.
3. The assistant's first call runs `test_connection`: the server sends `ping` to each device,
   then waits for `lastPing.id` to match.
4. Revoking the last grant (from the app, the assistant, or account deletion) sets `connected`
   false and deletes `assistantSnapshots`, `assistantDevices` and `assistantActivity`. Phones that
   see the flag turn false delete their own device and snapshot documents too.

## App Links

`https://alwaysontime.zombit.io/open/{destination}` with the app's verified
`assetlinks.json`, which Hosting serves on every domain, so links on
`always-on-time-zombit-2026.web.app` keep verifying too. Destinations: `event/{eventKey}`, `calendars`, `calendar/{calendarKey}`,
`settings/alarms`, `settings/sounds`, `settings/spoken`, `permissions`, `battery`, `travel`,
`account`, `assistants`, `plus?source=assistant`. Links only open screens; they never change
settings and never contain titles.

## Changing the protocol

Update this file and [`assistant-protocol-vectors.json`](assistant-protocol-vectors.json) in the
same change as the code, and ship the side that must accept a value before the side that sends it.

- **A new preference:** add it to `PREFERENCE_*` in
  [`assistant-records.js`](../functions/assistant-records.js), the vectors' `preferences` and the
  list above, with its range or allowed values, and to `isRecordId` in
  [`firestore.rules`](../firestore.rules) (a test keeps it equal to the allowlist); deploy the rules,
  then add it to the app's account-sync allowlist. Expose it
  to assistants through `SETTINGS` in [`assistant-settings.js`](../functions/assistant-settings.js)
  (the schema comes from the allowlist), and decide whether `changeAlert` should flag it.
- **A new tool:** add it to the read, write or connection module, list it in
  [ASSISTANT_CONNECTOR.md](ASSISTANT_CONNECTOR.md#tools), and set its annotations; a tool that can
  stop alarms is `destructiveHint: true` and its writes go through `writeTool` so they are logged,
  pushed and undoable.
- **A new capability:** allow it in [`firestore.rules`](../firestore.rules) and deploy the rules
  first (phones that write an unknown capability are rejected), then add it to `CAPABILITIES` in
  [`assistant-tools-connection.js`](../functions/assistant-tools-connection.js) and this file, and
  finally ship the app.
- **A new App Link destination:** the app's link routing must handle it first. Then add it to
  `DESTINATIONS` and `appLink` in [`assistant-snapshot.js`](../functions/assistant-snapshot.js)
  (`open_in_app` takes its values) and this file's App Links list. The Hosting fallback in
  `account-web/open/` serves every path, so it needs no change.

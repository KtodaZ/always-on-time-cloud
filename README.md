# Always On Time — cloud code

[![Verify live](https://github.com/KtodaZ/always-on-time-cloud/actions/workflows/verify.yml/badge.svg)](https://github.com/KtodaZ/always-on-time-cloud/actions/workflows/verify.yml)
[![Test](https://github.com/KtodaZ/always-on-time-cloud/actions/workflows/test.yml/badge.svg)](https://github.com/KtodaZ/always-on-time-cloud/actions/workflows/test.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/KtodaZ/always-on-time-cloud/badge)](https://scorecard.dev/viewer/?uri=github.com/KtodaZ/always-on-time-cloud)

This is the server-side code for [Always On Time: Calendar Alarm](https://play.google.com/store/apps/details?id=com.zombitstudios.alwaysontime).
It is the code that receives, stores or forwards user data, published so anyone can check what
happens to that data after it leaves the phone.

The app itself schedules alarms on the phone. Your calendar is read and processed on your device;
none of the code here reads your calendar. Everything below is optional or limited to what a
specific feature needs.

## Is this really what runs in production?

Production (`always-on-time-zombit-2026`) is deployed by the public
[Deploy workflow](.github/workflows/deploy.yml), which signs what it deploys. The
[Verify live workflow](.github/workflows/verify.yml) checks every day that each live function
(source and settings), rules file, index setting and hosted file carries that signature and matches
this repository, and that Google Cloud's audit log shows no deploys or deploy-access changes from
anywhere else. Its badge above is the current result. The checks detect changes rather than prevent
them; how they work, how to check a file yourself, and their limits:
[docs/DEPLOYING.md](docs/DEPLOYING.md).

## What is here

| Feature | Code | Data it handles |
| --- | --- | --- |
| Account sync (optional Google sign-in) | [`functions/account-sync*.js`](functions/account-sync.js), [`firestore.rules`](firestore.rules) `/accounts/{uid}` | Supported settings, hashed calendar/event identifiers, alarm overrides, 14 days of alarm history (event titles, action times, device model label; at most 5,000 entries). Only the signed-in owner can read or write it. |
| Account deletion | `deleteSyncedAccount`, [`account-web/delete-account/`](account-web/delete-account/index.html) | Revokes assistant connections, then deletes synced settings, history and the Firebase Auth identity; keeps a disabled UID marker so old tokens cannot recreate data. A deletion that stops partway is finished by `resumeAccountDeletions`. |
| History retention | `pruneSyncedHistory`, `capSyncedHistory` | Daily cleanup of synced history older than 14 days; an account keeps at most its newest 5,000 entries. |
| Travel routes | [`functions/travel-route*.js`](functions/travel-route.js) | Start/destination coordinates and times for one route request, forwarded to TomTom or Google Routes. Not stored; only call counters (per installation, per hashed client network and per provider) are kept, and they expire. |
| Feedback | [`functions/index.js`](functions/index.js), [`feedback-notification.js`](functions/feedback-notification.js), [`storage.rules`](storage.rules) | Feedback text, contact email, optional screenshots and an optional redacted diagnostics file. The contact email is never included in the developer notification. Uploads no feedback references are deleted after a day. |
| iOS calendar refresh relay | [`functions/ios-push-*.js`](functions/ios-push-service.js), [protocol](docs/IOS_PUSH_PROTOCOL.md) | APNs token, hashed install secret, hashed alarm and subscription IDs with times. Never OAuth tokens, event titles, calendar IDs or meeting links. |
| AI assistant connector (optional) | [`functions/assistant-*.js`](functions/assistant-functions.js), [`account-web/connect/`](account-web/connect/index.html), [docs](docs/ASSISTANT_CONNECTOR.md) | Only after the user connects Claude or ChatGPT: a snapshot of upcoming event titles, times, calendar names and alarms shared by the phone, a 30-day log of the assistant's changes, and hashed OAuth tokens. Deleted when the last assistant disconnects. |
| Account pages | [`account-web/`](account-web/) | The account deletion page, the assistant consent page and the App Link fallback, served at `https://alwaysontime.zombit.io`. The [privacy policy](https://zombit.io/always-on-time/privacy/) is published on the Zombit Studios website. |

More detail: [assistant connector](docs/ASSISTANT_CONNECTOR.md) and its
[protocol](docs/ASSISTANT_PROTOCOL.md), [feedback](docs/FEEDBACK.md), [travel routes](docs/TRAVEL_ROUTES.md),
[iOS relay protocol](docs/IOS_PUSH_PROTOCOL.md), [privacy policy](docs/PRIVACY_POLICY.md),
[deploying](docs/DEPLOYING.md).

## Tests

```sh
npm ci && npm ci --prefix functions && npm test
```

Firestore and Storage security rules, the Firestore store, account deletion and the assistant connector also have emulator tests (Java 21 and the
Firebase CLI). The emulators load every function, so give the declared secrets and params stand-in
values first:

```sh
printf 'APNS_AUTH_KEY_P8=x\nFEEDBACK_DISCORD_WEBHOOK_URL=http://127.0.0.1:9/\nTOMTOM_API_KEY=x\nTRAVEL_ROUTE_API_KEY=x\n' > functions/.secret.local
cp functions/.env.always-on-time-zombit-2026 functions/.env.local
npx firebase emulators:exec --only firestore,storage --project demo-account-sync 'node functions/testing/storage-rules.cjs && node functions/testing/account-sync-rules.cjs && node functions/testing/assistant-rules.cjs && npm --prefix functions test'
npx firebase emulators:exec --only auth,firestore,functions,hosting --project demo-account-sync 'node functions/testing/hosting-headers.cjs && node functions/testing/account-delete.cjs && node functions/testing/assistant-e2e.cjs'
```

The [Test workflow](.github/workflows/test.yml) runs all of these on every push and pull request.

## Contributing and security

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Report security
problems privately as described in [SECURITY.md](SECURITY.md). Privacy questions:
zombit.studios@gmail.com.

## License

[Apache License 2.0](LICENSE). Copyright 2025-2026 Zombit Studios LLC. The Always On Time name and
icon are not covered by the license.

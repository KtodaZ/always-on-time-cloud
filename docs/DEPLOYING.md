# Deploying

Production (`always-on-time-zombit-2026`) is deployed only by the
[Deploy workflow](../.github/workflows/deploy.yml): run it by hand from `main` (Actions > Deploy >
Run workflow) and choose the targets, for example `functions:calculateTravelRoute` or `hosting`.
The run log shows the commit and everything that changed.

The workflow has no stored credential. It signs in to Google Cloud through Workload Identity
Federation, and the identity pool only accepts `workflow_dispatch` runs on `refs/heads/main` of
this repository. The deploy service account (repository variable `GCP_DEPLOY_SERVICE_ACCOUNT`) has
the Firebase and Cloud Functions roles a deploy needs.

Secrets stay in Secret Manager and are bound to functions at deploy time:

| Secret | Used by |
| --- | --- |
| `FEEDBACK_DISCORD_WEBHOOK_URL` | `publishFeedbackNotification` |
| `TOMTOM_API_KEY`, `TRAVEL_ROUTE_API_KEY` | `calculateTravelRoute` |
| `APNS_AUTH_KEY_P8` | iOS relay push functions |

Non-secret params are in [`functions/.env.always-on-time-zombit-2026`](../functions/.env.always-on-time-zombit-2026).
The deploy does not pass `--force`, so if the source no longer exports a live function the deploy
stops instead of deleting it; delete retired functions deliberately with
`firebase functions:delete`.

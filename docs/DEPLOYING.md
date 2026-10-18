# Deploying

Production (`always-on-time-zombit-2026`) is deployed only by the
[Deploy workflow](../.github/workflows/deploy.yml): run it by hand from `main` (Actions > Deploy >
Run workflow) and choose the targets, for example `functions:calculateTravelRoute` or `hosting`.
Tick **dry run** to see what would change without deploying. Each run appears in the repository's
`production` deployments with its commit.

## How a deploy signs in

The workflow has no stored credential. GitHub issues the run a short-lived identity token, and
Google Cloud's Workload Identity Federation exchanges it for the deploy service account
(`github-deploy`) only when the token says it comes from `.github/workflows/deploy.yml` on
`refs/heads/main` of this repository, started by hand. Other workflows, branches, forks and pull
requests cannot deploy.

The run has three jobs:

1. **test** runs the tests and checks the targets, with no cloud identity.
2. **deploy** refuses to run unless its commit is still the head of `main` (so an old run cannot
   roll production back), installs packages without install scripts, and deploys.
3. **sign** installs no packages; it downloads what is now live and signs it.

Secrets stay in Secret Manager and are bound to functions at deploy time:

| Secret | Used by |
| --- | --- |
| `FEEDBACK_DISCORD_WEBHOOK_URL` | `publishFeedbackNotification`, `sendAssistantUsageSummary` |
| `TOMTOM_API_KEY`, `TRAVEL_ROUTE_API_KEY` | `calculateTravelRoute` |
| `APNS_AUTH_KEY_P8` | iOS relay push functions |

Non-secret params are in [`functions/.env.always-on-time-zombit-2026`](../functions/.env.always-on-time-zombit-2026).
The deploy does not pass `--force`, so if the source no longer exports a live function the deploy
stops instead of deleting it. The Firebase CLI version is pinned in the root `package-lock.json`.

## Signing what was deployed

After deploying, the workflow downloads what is now live and signs it with a
[build provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations):

- each function this deploy updated: the exact source zip Google built it from, and its settings
  (runtime, memory, region, trigger, environment, secret names, who may invoke it);
- the active Firestore and Storage rules, and the Firestore index and field settings;
- every file in the live Firebase Hosting release, plus its headers and redirects.

The signature (Sigstore, recorded in a public transparency log) binds each file's SHA-256 to this
repository, the Deploy workflow, the commit and the run.

## Verifying production

The [Verify live workflow](../.github/workflows/verify.yml) runs daily, after every deploy, and on
demand, with a read-only account (`github-verify`, usable only by that workflow file on `main`).
It fails if:

1. any live function archive or settings, rules file, index setting or hosting file lacks a
   signature from the Deploy workflow on `main`;
2. any of those differs from the repository at the commit its signature names, or a file in
   `account-web/` is missing from hosting;
3. the project has something the signatures do not cover: a Cloud Run service that is not one of
   the functions, another hosting site, a preview channel, or another Firestore database; or
4. Google Cloud's Admin Activity audit log shows a deploy of functions, rules, indexes, schedules or
   Cloud Run services by anyone other than the Deploy workflow, or any change to who can deploy
   (workload identity providers, service account keys, token-creator or similar grants, or IAM on
   the deploy and verify accounts). Audit monitoring starts at `MONITORING_STARTS` in
   [`scripts/verify-live.mjs`](../scripts/verify-live.mjs) and always covers everything since.

It also lists other changes made outside CI, such as secret rotation or enabling an API, without
naming people. Any hosting change in the audit log other than a custom domain change counts as a deploy,
but hosting releases have not been seen there, so hosting relies mainly on the signature check.

You can check a file yourself with the GitHub CLI. For example, the account deletion page:

```sh
curl -s https://alwaysontime.zombit.io/delete-account/ -o delete-account.html
gh attestation verify delete-account.html --repo KtodaZ/always-on-time-cloud \
  --cert-identity https://github.com/KtodaZ/always-on-time-cloud/.github/workflows/deploy.yml@refs/heads/main \
  --cert-oidc-issuer https://token.actions.githubusercontent.com
```

### What this does not prove

- The checks detect changes; they cannot stop a project owner from changing production.
- Settings that are not code (secret values, App Check enforcement, the Storage bucket's lifecycle
  rule, billing) are not signed, though changes to them appear in the audit log listing.
- The deploy job runs the Firebase CLI and this repository's function code (to discover functions)
  while it holds the deploy identity, so a malicious locked dependency could act during a deploy.
  The lockfiles are reviewed through Dependabot pull requests, and anything it deployed would still
  need to match the repository to pass verification.
- GitHub disables scheduled workflows after 60 days without repository activity; the badge then
  goes stale rather than red.
- The Android and iOS apps are built from a separate private repository.

### One-time setup before monitoring

On 2026-10-16 the maintainer created the deploy and verify service accounts, the Workload Identity
pool and providers, their IAM bindings, the gcf-sources bucket read access, and the
`FEEDBACK_DISCORD_WEBHOOK_URL` secret. Earlier production deploys were made from the maintainer's
machine; the first signed deploy replaced every function, rules file and hosting file. The
maintainer also enabled the Cloud Billing API during that deploy, because the Firebase CLI reads the
project's billing plan; that change is listed in the Verify report.

## Hosting domains

The public origin is `https://alwaysontime.zombit.io`, a custom domain on the project's Hosting
site. Hosting serves the same release on the site's default domains,
`always-on-time-zombit-2026.web.app` and `always-on-time-zombit-2026.firebaseapp.com`:

- `/` and `/privacy-policy.html` redirect to the Zombit Studios website on every domain.
- The assistant connector's OAuth and discovery paths redirect to the custom domain, and `/mcp`
  answers with an error naming the new URL ([details](ASSISTANT_CONNECTOR.md#endpoints)).
- The account pages, `/open/**` and `/.well-known/assetlinks.json` are served on every domain, so
  App Links verify on both the custom and the default domain.

The account pages sign in with a popup through Firebase Auth's `authDomain`
(`always-on-time-zombit-2026.firebaseapp.com`), which works from any domain listed in Firebase
Auth's authorized domains. The `apiKey` in
[`account-web/firebase-config.json`](../account-web/firebase-config.json) is Firebase's public
web client identifier, not a secret; in Google Cloud it is limited to the Firebase Auth APIs and
to requests from the three hosting domains above. The custom domain is connected in the Firebase console (Hosting > Add
custom domain, plus the DNS records it shows); the Verify report lists that as a configuration
change, not a deploy.

## Repository protections

`main` cannot be force-pushed or deleted. Actions are pinned to commit hashes and updated by
Dependabot, workflow tokens default to read-only, and secret scanning with push protection, CodeQL
and [OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/KtodaZ/always-on-time-cloud)
run on the repository.

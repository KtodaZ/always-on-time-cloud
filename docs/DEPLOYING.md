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

Secrets stay in Secret Manager and are bound to functions at deploy time:

| Secret | Used by |
| --- | --- |
| `FEEDBACK_DISCORD_WEBHOOK_URL` | `publishFeedbackNotification` |
| `TOMTOM_API_KEY`, `TRAVEL_ROUTE_API_KEY` | `calculateTravelRoute` |
| `APNS_AUTH_KEY_P8` | iOS relay push functions |

Non-secret params are in [`functions/.env.always-on-time-zombit-2026`](../functions/.env.always-on-time-zombit-2026).
The deploy does not pass `--force`, so if the source no longer exports a live function the deploy
stops instead of deleting it. The Firebase CLI version is pinned in the root `package-lock.json`.

## Signing what was deployed

After deploying, the workflow downloads what is now live and signs it with a
[build provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations):

- each deployed function's source archive, the exact zip Google built the function from;
- the active Firestore and Storage rules;
- every file in the live Firebase Hosting release.

The signature (Sigstore, recorded in a public transparency log) binds each file's SHA-256 to this
repository, the Deploy workflow, the commit and the run. Index-only deploys change no signed file.

## Verifying production

The [Verify live workflow](../.github/workflows/verify.yml) runs daily, after every deploy, and on
demand, with a read-only account (`github-verify`, usable only by that workflow file on `main`).
It fails if:

1. any live function archive, rules file or hosting file lacks a signature from the Deploy
   workflow on `main`;
2. any of those files differs from the repository at the commit its signature names; or
3. Google Cloud's Admin Activity audit log shows a deploy of functions, rules, indexes, schedules or
   Cloud Run services, or a key or access grant for the deploy account, by anyone other than the
   deploy account. Audit monitoring starts at `MONITORING_STARTS` in
   [`scripts/verify-live.mjs`](../scripts/verify-live.mjs).

It also lists other changes made outside CI, such as secret rotation or permission changes, without
naming people. Hosting releases are not in the audit log, so hosting is covered by the signature
check alone.

You can check a file yourself with the GitHub CLI. For example, the privacy policy:

```sh
curl -sO https://always-on-time-zombit-2026.web.app/privacy-policy.html
gh attestation verify privacy-policy.html --repo KtodaZ/always-on-time-cloud \
  --signer-workflow KtodaZ/always-on-time-cloud/.github/workflows/deploy.yml --source-ref refs/heads/main
```

### What this does not prove

The checks detect changes; they cannot stop a project owner from changing production. Settings
that are not code (secret values, App Check enforcement, billing) are not signed, though changes to
them appear in the audit log listing. The Android and iOS apps are built from a separate private
repository.

### One-time setup before monitoring

On 2026-10-16 the maintainer created the deploy and verify service accounts, the Workload Identity
pool and providers, their IAM bindings, the gcf-sources bucket read access, and the
`FEEDBACK_DISCORD_WEBHOOK_URL` secret. Earlier production deploys were made from the maintainer's
machine; the first signed deploy replaced every function, rules file and hosting file.

## Repository protections

`main` cannot be force-pushed or deleted. Actions are pinned to commit hashes and updated by
Dependabot, workflow tokens default to read-only, and secret scanning with push protection, CodeQL
and [OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/KtodaZ/always-on-time-cloud)
run on the repository.

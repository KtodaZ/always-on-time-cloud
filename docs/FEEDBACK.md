# Feedback

The Android app's **Leave feedback** form writes one document to the `feedback` collection. It
needs a Firebase user only to authorize the uploads and the write. The document has no user field,
but attachment paths contain that user's ID (`feedback/{uid}/…`, both in Cloud Storage and in the
document's attachment entries):

- App versions up to now use whichever Firebase user the app has: an anonymous one, or, when the
  user has signed in with Google for account sync, that account's ID (signing in keeps the earlier
  anonymous ID), so attachments can be linked to a synced account.
- Newer versions always use a separate anonymous identity for feedback, unrelated to account sync.

## What is stored

- `feedback/{id}` in Firestore: the message (up to 5,000 characters), a required contact email,
  app version, platform, server timestamp, and metadata for up to three images and one optional
  diagnostics file (path, type, size; older app versions also store each image's download URL).
- `feedback/{uid}/{id}/{attachmentId}` in Cloud Storage: images (raster types, 5 MB each) and the
  optional redacted diagnostics text file (5 MB).

[`firestore.rules`](../firestore.rules) only lets a client create a document with exactly those
fields; nobody can read, update or delete feedback through client SDKs.
[`storage.rules`](../storage.rules) lets only the uploader create its own objects (never overwrite
them), and other app users cannot read them. The uploader can still read its own objects because
older app versions ask for a download URL after each upload and drop the image if they can't get
one; that permission goes once versions that don't ask are widespread. The developer reads
feedback with admin credentials.

Uploads that no feedback document references a day later (an abandoned or failed submission) are
deleted by `deleteOrphanFeedbackUploads` ([`storage-limits.js`](../functions/storage-limits.js)),
which runs every 6 hours. Attachments are deleted automatically 180 days after upload by a
lifecycle rule on the Storage bucket, within the privacy policy's limit of 24 months for feedback
records.

## Diagnostics scrub

The app redacts the diagnostics file before upload. `scrubFeedbackDiagnostics`
([code](../functions/feedback-log-scrub.js), [tests](../functions/test/feedback-log-scrub.test.js))
runs when a `text/plain` object under `feedback/` is finalized and applies the same rules again:
emails, links (meeting links keep only a provider tag), maps links, coordinates, street addresses,
phone numbers, dial-in codes, tokens, and named personal fields such as `title=`. Alarm IDs, times,
time zones and stack traces stay readable, and the app's own tags pass through unchanged. If
anything changes, the object is rewritten; either way it gets the `aotScrubbed` metadata marker,
which stops the rewrite from being scrubbed again. A generation precondition leaves a file that
changed while it was read for its own trigger. The scrub covers files from app versions released
before a client rule existed.

## Developer alert

`publishFeedbackNotification` runs when a document is created and posts a short alert to a
webhook in the developer's private Discord channel: the app version, platform, and how many images
and logs are attached, with a link to the record in the Firebase console (which needs the
developer's sign-in). The message, contact email, images and diagnostics are never sent to Discord
([tests](../functions/test/feedback-notification.test.js)), and the alert cannot mention anyone.

The webhook URL is the `FEEDBACK_DISCORD_WEBHOOK_URL` secret in Secret Manager, so it is not in this
repository. A webhook can post to its channel but cannot read it. Cloud Functions delivery is at
least once, so a retry can produce a duplicate alert; the Firestore document is the source of
truth.

Alerts are capped per hour: past the cap, one alert says feedback is arriving quickly, and the
next hour's first alert says how many arrived without one. The count is kept in
`feedbackAlerts/{hour}` (a number only, deleted by a TTL policy). A refusal from Discord (any 4xx,
including rate limiting) is logged and not retried; server errors are retried for up to an hour.

To change the webhook, set a new secret version and redeploy the function:

```sh
firebase functions:secrets:set FEEDBACK_DISCORD_WEBHOOK_URL
```

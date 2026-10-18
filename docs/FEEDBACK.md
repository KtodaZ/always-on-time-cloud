# Feedback

The Android app's **Leave feedback** form writes one document to the `feedback` collection. It
signs in with Firebase Anonymous Authentication only to authorize the write; that identifier is
not stored in the document.

## What is stored

- `feedback/{id}` in Firestore: the message (up to 5,000 characters), a required contact email,
  app version, platform, server timestamp, and metadata for up to three images and one optional
  diagnostics file.
- `feedback/{uid}/{id}/{attachmentId}` in Cloud Storage: images (raster types, 5 MB each) and the
  optional redacted diagnostics text file (5 MB).

[`firestore.rules`](../firestore.rules) only lets a client create a document with exactly those
fields; nobody can read, update or delete feedback through client SDKs.
[`storage.rules`](../storage.rules) lets only the uploader create its own objects (never overwrite
them), and other app users cannot read them. The developer reads feedback with admin credentials.
Attachments are deleted automatically 180 days after upload by a lifecycle rule on the Storage
bucket, within the privacy policy's limit of 24 months for feedback records.

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

To change the webhook, set a new secret version and redeploy the function:

```sh
firebase functions:secrets:set FEEDBACK_DISCORD_WEBHOOK_URL
```

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
[`storage.rules`](../storage.rules) lets only the uploader write its own objects, and other app
users cannot read them. The developer reads feedback with admin credentials.

## Developer alert

`publishFeedbackNotification` runs when a document is created and posts a short alert to the
developer's ntfy topic: the app version, platform, and how many images and logs are attached, with
a tap-through to the record in the Firebase console (which needs the developer's sign-in). The
message, contact email, images and diagnostics are never sent to ntfy
([tests](../functions/test/feedback-notification.test.js)).

The topic URL is the `FEEDBACK_NTFY_URL` secret in Secret Manager, an unguessable topic name, so
it is not in this repository. Cloud Functions delivery is at least once, so a retry can produce a
duplicate alert; the Firestore document is the source of truth.

To change the topic, set a new secret version and redeploy the function:

```sh
firebase functions:secrets:set FEEDBACK_NTFY_URL   # paste https://ntfy.sh/<random topic>
```

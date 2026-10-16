# Always On Time Privacy Policy

**Effective date:** October 16, 2026

Always On Time: Calendar Alarm is an Android and Wear OS alarm application provided by
Zombit Studios LLC.

## Information processed on your devices

With your permission, the app reads selected calendar details, including event titles,
descriptions, times, and meeting links, to schedule alarms. Alarm preferences and history are
stored locally on your device.

The app does not display ads, use AdMob, or use behavioral advertising.

## Travel-time alarms and location

Travel-time alarms are off by default. If you turn them on, you choose where trips start from.

**Use my location.** With your permission to access location all the time, the app collects your
device's location, including when the app is closed or not in use, to work out when you need to
leave for in-person calendar events. Location is read only when an in-person event is coming up,
when a leave-time alarm rings, or when you open the app; the app does not track you continuously.
The most recent location is stored on your device, left out of backups and device transfers, and
deleted when you turn off travel-time alarms or switch to "Use my places."

**Use my places.** The app never reads your device's location. Trips start from places you save,
such as Home, Work or Gym, following a weekly schedule of where you usually are. Saved places and
their map coordinates are stored on your device. You can also save places when using your
location.

**Who we share this with.** When planning a trip, the starting point (your location or a saved
place), the calendar destination, the transport mode, and the appointment time are sent through
the developer's Google Firebase routing service to one of these route providers: TomTom (for
driving, cycling and walking) or Google (for public transit, or when TomTom is unavailable). The
event address is first matched to map coordinates by your phone's built-in geocoder, which on most
phones is provided by Google. Address search while saving places uses Google Places. Routing
requests happen only for physical events without a detected meeting link. Location is not used for
advertising and is not sold or shared for any other purpose.

To prevent abuse, the routing service checks that requests come from a genuine copy of the app
(Firebase App Check with Google Play Integrity) and counts each installation's daily route requests
by its Firebase installation ID; those counts are kept for about two days. Trip details are not
stored by the routing service. If routing is unavailable, the app keeps the last successful plan or
falls back to the event's existing alarms.

## Always On Time Plus subscription

Always On Time Plus is an optional subscription sold through Google Play. Google Play processes
payment and your Google account details under Google's terms; the developer does not receive your
payment details. The app reads from Google Play whether your subscription is active and stores
that status on your device. Manage or cancel the subscription in Google Play.

## Optional Google account sync

When you choose **Sign in with Google** in Settings, Google Firebase Authentication processes
your Google profile, email address, and account identifier to identify your Always On Time
account. Sign-in does not give the app access to your Gmail or Google Calendar through Google's
web APIs; calendar access still uses the phone's calendar permission.

While signed in, the app saves supported alarm and appearance preferences, selected-calendar
choices, calendar and recurring-series alarm rules, and individual event overrides to Firebase
Cloud Firestore. Calendar and event matching identifiers are hashed; they remain account data,
not anonymous data. These settings restore after reinstalling or changing phones and update
other signed-in phones when those phones can connect. Offline edits are queued on the phone.
For simultaneous edits to the same setting, the last accepted upload wins.

The app also saves the most recent 14 days of calendar alarm history: event titles, event and
alarm times, dismiss/snooze actions, lead times, and a device model label. History from other
phones is shown for reference and never recreates or triggers an alarm. Account sync does not
upload event descriptions, meeting URLs, destinations, saved places, custom sound
files or their device paths, local voice identifiers, permissions, or diagnostic-consent choices.

Google Firebase processes this information on the developer's behalf for account management,
backup, and synchronization. Signing out stops sync on that phone and keeps its local settings
and history; it does not delete the saved account. Cloud history older than 14 days is removed
by a daily cleanup, so deletion can take up to an additional day. Other account settings remain
until you delete your Always On Time account.

Choose **Settings > Account > Manage account > Delete account**, or use the
[account deletion page](https://always-on-time-zombit-2026.web.app/delete-account/), to delete
saved account settings, synced history, and your Always On Time authentication identity.
You may need to sign in again to confirm deletion. A minimal disabled account identifier is
retained to block writes from previously issued authentication tokens. This does not delete
your Google account, Google calendars, local phone data, or separately submitted feedback and
diagnostics. Contact us using the deletion instructions below for feedback or diagnostic records.

## Wear OS companion

If you use the Wear OS companion, the alarm information needed to display and operate an
alarm is transferred between your paired phone and watch through Google Play services'
Wearable Data Layer. The phone remains authoritative for calendar data, settings, and history.

## Feedback and diagnostic information collected

When you choose **Leave feedback**, the app sends the text you enter, a required email address,
the app version, and a server-generated submission time to the developer's Firebase Cloud
Firestore database. Optional screenshots or photos are uploaded to Firebase Cloud Storage under a
user-scoped path that other app users cannot read. Firebase Anonymous Authentication creates a
random account identifier solely to authorize the submission; that identifier is not included in
the feedback document. After submission, a trusted Firebase backend sends the developer a short
alert through the ntfy notification service saying that feedback arrived. The alert contains only
the app version, the platform, and the number of attached images and logs; your feedback text,
email address, images, and logs are not included in it.

The feedback form also has an optional **Include app logs** checkbox, which is
checked by default. When selected, the app attaches a text export of Always On Time diagnostic
entries from the last 24 hours. Android system
`logcat` is not included because ordinary apps cannot read it. Links and email addresses are
removed from this export before upload. The log is stored privately in Firebase Cloud Storage for
developer review and is not included in the public notification channel.

When **Remote log streaming** is enabled in Settings > Developer, the app sends diagnostic
information to the developer's remote logging service to monitor alarm reliability and
troubleshoot problems. Fresh installs keep this setting off, and it can be disabled at any time
from the same menu. Firebase Crashlytics separately receives crash, non-fatal error, and
application-not-responding reports.

Diagnostic records can include:

- a Firebase Installation ID and a short identifier for the current app session;
- device manufacturer and model, device build family fields, Android release/API level, security
  patch level, app version/build type, supported CPU ABIs, locale, IP-derived approximate
  location, timestamps, and log severity;
- network availability, internet validation, metered state, and transport type; battery percentage,
  charging, and power-save state; available/total memory and low-memory status; and available/total
  app-storage capacity in an explicit diagnostics export or when a feedback or diagnostic
  transport failure is recorded;
- app interactions and technical diagnostic messages; and
- calendar-event titles and internal identifiers when the app records
  scheduling, synchronization, cancellation, alarm, or restoration activity.

Failure context does not include serial numbers, Android IDs, IMEI/SIM identifiers, Wi-Fi or
Bluetooth names, precise location, feedback text, contact email, or attachment contents. The
separate feedback submission still contains the information described above when you choose to
send it.

The app does not sell this information. Feedback is used to improve the app and respond to
reported problems. Diagnostics are used only for app-health analytics, troubleshooting,
security, and reliability improvements. Service providers, including Google Firebase and the
developer's hosting provider, process information on the developer's behalf. Information is
transmitted using HTTPS.

## Other network requests

The app may request public, manufacturer-specific battery guidance from DontKillMyApp.com.
The request can reveal the device manufacturer and IP address, but it does not intentionally
include calendar events or meeting links.

## Retention and deletion

Feedback and diagnostic records may be retained for up to 24 months and may then be deleted or
retained only in aggregated form. To request deletion of remotely collected feedback or
diagnostics, email
zombit.studios@gmail.com with the subject "Always On Time data deletion." Include the device
model and approximate dates of use, plus the feedback text, Firebase Installation ID, or
diagnostic session ID if available, so matching records can be located. Zombit Studios will
respond within a reasonable period and will explain if records cannot be reliably identified
from the details provided.

Local app data remains on your devices until you delete it in the app, clear the app's storage,
or uninstall the app. Wear alarm records are removed or replaced as alarms are completed,
cancelled, or updated.

## Permissions

The app requests permissions needed for calendar access, notifications, exact alarms,
full-screen alarm presentation, vibration, startup restoration, and related reliability
features, plus location (including all the time) if you choose "Use my location" for travel-time
alarms. Permissions can be reviewed or revoked in Android system settings.

## Children

The app is not directed to children under 13 and does not knowingly collect personal
information from children under 13. If you believe a child has supplied personal information,
contact zombit.studios@gmail.com.

## Open-source cloud code

The server code that receives, stores, or forwards the information described in this policy is
published at [github.com/KtodaZ/always-on-time-cloud](https://github.com/KtodaZ/always-on-time-cloud), and production updates are deployed
from that repository.

## Changes

This policy may be updated when app behavior changes. The effective date above identifies the
current version.

## Contact

Privacy questions and deletion requests can be sent to zombit.studios@gmail.com.

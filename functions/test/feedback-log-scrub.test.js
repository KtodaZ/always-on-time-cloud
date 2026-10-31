"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SCRUB_METADATA_KEY, SCRUB_VERSION, needsScrub, scrubDiagnosticLog, scrubDiagnosticText, scrubFeedbackDiagnosticObject,
} = require("../feedback-log-scrub");

const DEBUG_LINES = [
  "2026-10-23T17:02:11.123Z INFO/Unknown: Upcoming notice selection: alarmId=7812 instanceId=214 sourceEventId=1435 " +
    "calendarId=9 alarmTimeMillis=1729700400000 eventStartMillis=1729701000000 leadMinutes=10 purpose=travel_departure " +
    "timeZone=America/Los_Angeles",
  "2026-10-23T17:02:11.123Z INFO/Unknown: Snooze scheduled: sourceAlarmId=5 snoozeAlarmId=-2147480000 instanceId=214 " +
    "eventStartMillis=1729701000000 returnTimeMillis=1729700700000 snoozeMinutes=5",
  "2026-10-23T17:02:11.123Z DEBUG/Unknown: Triggered by URI: content://com.android.calendar/instances/when/1729700000000/1729786400000",
  "2026-10-23T17:02:11.123Z INFO/Unknown: ACTION_STOP_IF_OWNER: firing=12345678-1234-1234-1234-123456789012 owns the service",
  "2026-10-23T17:02:11.123Z WARN/Unknown: [diagnostic-failure] flow=feedback stage=upload-image appVersion=3.4.1 " +
    "model=SM-S918U1 securityPatch=2026-09-01 supportedAbis=arm64-v8a,armeabi-v7a locale=en-US memoryAvailableBytes=3456789012",
  "2026-10-23T17:02:11.123Z WARN/Unknown: Upload failed throwable=com.google.firebase.storage.StorageException: " +
    "User does not have permission\\n\\tat com.google.firebase.storage.b.run(SourceFile:12)\\n{  \"error\": {    " +
    "\"code\": 403,    \"message\": \"Permission denied.\"  }}",
  "Entries: 4123",
  "Assistant: push received type=ping pingId=p_0012 tokenDeleted=true",
  "Calendar <email:h=3fa2c1> sync failed title=<title:len=19,h=9b0e11> calendarName=<calendarName:len=4,h=a1b2c3>",
  // The iOS app's diagnostics file: numbered account sources and its own redaction tags.
  "Always On Time 1.0 (7), iOS 26.0, source=ios",
  "source google:#1: error none success 1729700000000 unavailable 0",
  "1729700400000 fetchFailed extension push eventkit:6F1C2A3B-1234-1234-1234-123456789012 network URLError(NSURLErrorDomain#-1009)",
  "relay: enabled false reason apns_bad_device_token environment production verified false eligible true receipt v1 last push never",
  "wake 1700000100000 change delivery true complete receipt uploaded(count: 2)",
  "open <redacted-url> failed from <redacted-email> dial <redacted-phone> at <redacted-coords>",
];

test("debug fields and the app's own tags pass through unchanged", () => {
  for (const line of DEBUG_LINES) assert.equal(scrubDiagnosticText(line), line);
});

test("links, contact data, places and secrets are removed", () => {
  const cases = [
    ["Join https://meet.google.com/abc-defg-hij now", "Join <meeting-url:meet> now"],
    ["Join us02web.zoom.us/j/81234567890.", "Join <meeting-url:zoom>."],
    ["owner jane.doe@gmail.com", "owner <redacted-email>"],
    ["calendarId=abc%40group.calendar.google.com", "calendarId=<redacted-email>"],
    ["Dial +1 (415) 555-0132", "Dial <redacted-phone>"],
    ["Dial 020 7946 0958", "Dial <redacted-phone>"],
    ["PIN: 123 456 789#", "PIN: <redacted-number>"],
    ["origin 37.42199, -122.08405 ok", "origin <redacted-coords> ok"],
    ["lat=37.42199 lng=-122.08405", "lat=<redacted> lng=<redacted>"],
    ["Route to 1600 Amphitheatre Parkway, Mountain View, CA 94043 failed", "Route to <redacted-address> failed"],
    ["title=\"Weekly 1:1 with Sam\" leadMinutes=5", "title=<title:len=19> leadMinutes=5"],
    ["location: Board Room 4, purpose=meeting", "location: <location:len=12>, purpose=meeting"],
    ["Notification “Team sync with Alex” posted", "Notification “<text:len=19>” posted"],
    ["Authorization: Bearer ya29.a0AfH6SMBx-abc_def", "Authorization: Bearer <redacted-secret>"],
    ["Unable to reach https://routes.googleapis.com/directions/v2:computeRoutes?key=abc", "Unable to reach <url:routes.googleapis.com>"],
    ["open www.acme-corp.com", "open <redacted-url>"],
  ];
  for (const [input, expected] of cases) assert.equal(scrubDiagnosticText(input), expected, input);

  const intent = scrubDiagnosticText(
    "No Activity found to handle Intent { act=android.intent.action.VIEW dat=geo:0,0?q=1600 Amphitheatre Parkway, " +
      "Mountain View flg=0x10000000 }",
  );
  assert.doesNotMatch(intent, /Amphitheatre|Mountain/);
  assert.match(intent, /act=android\.intent\.action\.VIEW dat=<redacted-location-url> flg=0x10000000/);
  assert.doesNotMatch(scrubDiagnosticText("open geo:0,0?q=742 Evergreen Terrace throwable=x"), /Evergreen/);
});

test("scrubbing is stable when repeated", () => {
  const log = [
    "a https://meet.google.com/abc-defg-hij b jane@example.com title=\"Quarterly planning\" at 37.42199, -122.08405",
    "call +1 415-555-0132",
  ].join("\n");
  const once = scrubDiagnosticLog(log);
  assert.equal(scrubDiagnosticLog(once), once);
  assert.equal(once.split("\n").length, 2);
});

test("only unscrubbed feedback text files are scrubbed", () => {
  const object = { name: "feedback/uid/fid/aid", contentType: "text/plain", size: "120", metadata: {} };
  assert.equal(needsScrub(object), true);
  assert.equal(needsScrub({ ...object, contentType: "image/png" }), false);
  assert.equal(needsScrub({ ...object, name: "accounts/uid/file" }), false);
  assert.equal(needsScrub({ ...object, metadata: { [SCRUB_METADATA_KEY]: SCRUB_VERSION } }), false);
  assert.equal(needsScrub({ ...object, size: String(6 * 1024 * 1024) }), false);
});

function fakeBucket(contents) {
  const calls = [];
  return {
    calls,
    file: (name) => ({
      download: async () => [Buffer.from(contents, "utf8")],
      save: async (data, options) => calls.push({ op: "save", name, data, options }),
      setMetadata: async (metadata, options) => calls.push({ op: "setMetadata", name, metadata, options }),
    }),
  };
}

test("a file with personal data is rewritten with a marker and a generation precondition", async () => {
  const bucket = fakeBucket("ok alarmId=1\nJoin https://meet.google.com/abc-defg-hij\n");
  const object = { name: "feedback/u/f/a", contentType: "text/plain", size: "60", generation: "42", metadata: {} };
  const result = await scrubFeedbackDiagnosticObject(object, bucket);
  assert.deepEqual(result, { status: "scrubbed", changedLines: 1 });
  const [save] = bucket.calls;
  assert.equal(save.op, "save");
  assert.equal(save.data, "ok alarmId=1\nJoin <meeting-url:meet>\n");
  assert.equal(save.options.metadata.metadata[SCRUB_METADATA_KEY], SCRUB_VERSION);
  assert.deepEqual(save.options.preconditionOpts, { ifGenerationMatch: "42" });
  assert.equal(save.options.contentType, "text/plain");
});

test("a clean file is only marked, and a marked file is left alone", async () => {
  const bucket = fakeBucket("ok alarmId=1\n");
  const object = { name: "feedback/u/f/a", contentType: "text/plain", size: "13", generation: "7", metadata: {} };
  assert.deepEqual(await scrubFeedbackDiagnosticObject(object, bucket), { status: "clean" });
  assert.equal(bucket.calls[0].op, "setMetadata");
  assert.deepEqual(bucket.calls[0].options, { ifGenerationMatch: "7" });

  const marked = { ...object, metadata: { [SCRUB_METADATA_KEY]: SCRUB_VERSION } };
  assert.deepEqual(await scrubFeedbackDiagnosticObject(marked, fakeBucket("x")), { status: "skipped" });
});

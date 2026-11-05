"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const path = require("node:path");

const {
  PREFERENCE_BOOLEANS, PREFERENCE_INTEGERS, PREFERENCE_LONGS, PREFERENCE_STRINGS, PREFERENCE_STRING_LIMITS, PREFERENCE_STRING_MAX, RecordError,
  calendarKey, canonicalPayload, encodePayload, googleCalendarCandidates, googleEventKeys, occurrenceKey, originalStartMillis,
  parseGoogleEventId, samePayload, seriesKey, sha256Hex, validatePayload,
} = require("../assistant-records");

// Shared with the apps: docs/assistant-protocol-vectors.json. The Kotlin app tests against the same file.
const VECTORS = require(path.join(__dirname, "../../docs/assistant-protocol-vectors.json"));
const CALENDAR = VECTORS.recordKeys[0].key;
const HEX = "a".repeat(64);

test("record keys reproduce every shared test vector", () => {
  assert.equal(VECTORS.recordKeys.length, 6);
  for (const { kind, input, key } of VECTORS.recordKeys) {
    if (kind === "calendar") assert.equal(calendarKey(...input), key);
    else if (kind === "series") assert.equal(seriesKey(...input), key);
    else {
      assert.equal(`e_${sha256Hex(input)}`, key);
      const [series, start] = input.split(":");
      assert.equal(occurrenceKey(series, start === "single" ? null : Number(start)), key);
    }
  }
});

test("payloads encode to the canonical form in every shared vector", () => {
  assert.ok(VECTORS.payloads.length >= 8);
  for (const vector of VECTORS.payloads) {
    const recordId = vector.record === "p" ? `p_${vector.name}` : `${vector.record}_${HEX}`;
    assert.equal(encodePayload(recordId, vector.value), vector.canonical, vector.description);
    // Encoding the canonical form again changes nothing.
    assert.equal(canonicalPayload(recordId, vector.canonical), vector.canonical, vector.description);
  }
});

test("the preference allowlist matches the shared vectors", () => {
  const { booleans, integers, strings, longs } = VECTORS.preferences;
  assert.deepEqual([...PREFERENCE_BOOLEANS].sort(), [...booleans].sort());
  assert.deepEqual(Object.fromEntries(PREFERENCE_INTEGERS), integers);
  assert.deepEqual(Object.fromEntries([...PREFERENCE_STRINGS].map(([name, values]) => [name, { maxLength: PREFERENCE_STRING_LIMITS.get(name) ?? PREFERENCE_STRING_MAX, values }])), strings);
  assert.deepEqual(Object.fromEntries(PREFERENCE_LONGS), longs);
});

test("fields from a newer app are kept, after the known ones, and payloads compare by meaning", () => {
  const stored = '{"futureField":{"x":1},"enabled":true,"leadTimes":[10,5]}';
  assert.equal(canonicalPayload(`s_${HEX}`, stored), '{"leadTimes":[5,10],"enabled":true,"futureField":{"x":1}}');
  assert.equal(encodePayload(`c_${HEX}`, { future: 1, overrides: { soon: true, leadTimes: [0] }, selected: true }),
    '{"selected":true,"overrides":{"leadTimes":[0],"soon":true},"future":1}');
  assert.equal(samePayload(`e_${HEX}`, '{"enabled":false,"leadTimes":[10,0]}', '{"leadTimes":[0,10],"enabled":false,"volume":null}'), true);
  assert.equal(samePayload(`e_${HEX}`, '{"leadTimes":[0,10]}', '{"leadTimes":[0,15]}'), false);
  // A missing document means "nothing set".
  assert.equal(samePayload(`c_${HEX}`, null, '{"selected":null,"overrides":null}'), true);
  assert.equal(samePayload(`p_alarm_volume`, null, "null"), true);
  assert.equal(samePayload(`p_alarm_volume`, "not json", "not json"), true);
});

test("key inputs are escaped like kotlinx JSON and rejected when missing", () => {
  // Quotes and backslashes get JSON escapes, so they cannot collide with the list separators.
  assert.notEqual(calendarKey("com.google", "a\",\"b", "c"), calendarKey("com.google", "a", "b\",\"c"));
  assert.throws(() => calendarKey("com.google", "", "x"), RecordError);
  assert.throws(() => seriesKey("c_nothex", "x"), RecordError);
  assert.throws(() => occurrenceKey("s_123", 5), RecordError);
});

test("Google instance ids split into the series id and the original start in UTC", () => {
  assert.deepEqual(parseGoogleEventId("7rcurring0example_20261020T150000Z"),
    { seriesId: "7rcurring0example", originalStartMillis: Date.UTC(2026, 9, 20, 15) });
  // All-day instances: Android stores the start as UTC midnight.
  assert.deepEqual(parseGoogleEventId("7rcurring0example_20261020"),
    { seriesId: "7rcurring0example", originalStartMillis: Date.UTC(2026, 9, 20) });
  // Plain ids, split-series ids and impossible dates stay whole.
  assert.deepEqual(parseGoogleEventId("4kq0l1v3s9example"), { seriesId: "4kq0l1v3s9example", originalStartMillis: null });
  assert.deepEqual(parseGoogleEventId("abc_R20261020T150000"), { seriesId: "abc_R20261020T150000", originalStartMillis: null });
  assert.equal(parseGoogleEventId("abc_20261340").originalStartMillis, null);
});

test("Google event ids give the same keys the phone derives from CalendarContract", () => {
  const instanceTime = 1793124000000;
  const instanceId = `7rcurring0example_${new Date(instanceTime).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`;
  assert.equal(instanceId, "7rcurring0example_20261027T180000Z");
  const expected = "e_7b1ec89029a39d5b40d6ffb94cb7187192ac341db9b4f614b97fae4fc623abda";
  // From the instance id alone, from recurringEventId + originalStartTime, and from an exception's
  // own id (which Google also suffixes with the original start).
  assert.equal(googleEventKeys(CALENDAR, { eventId: instanceId }).eventKey, expected);
  assert.equal(googleEventKeys(CALENDAR, {
    eventId: "someexceptionid", recurringEventId: "7rcurring0example", originalStartTime: { dateTime: "2026-10-27T11:00:00-07:00" },
  }).eventKey, expected);
  assert.equal(googleEventKeys(CALENDAR, { eventId: "x", recurringEventId: "7rcurring0example", originalStartTime: "2026-10-27T18:00:00Z" }).eventKey, expected);
  const series = googleEventKeys(CALENDAR, { eventId: "y", recurringEventId: "7rcurring0example" });
  assert.deepEqual([series.seriesKey, series.eventKey, series.recurring],
    ["s_a4b8d08d97e8a3a8fd964c4e1811abafeb4c2ae465c396f6b6debbbf06929e5f", null, true]);
  // A bare id could be a single event or a series master; the caller checks the snapshot.
  const bare = googleEventKeys(CALENDAR, { eventId: "4kq0l1v3s9example" });
  assert.equal(bare.eventKey, "e_e41735eed816bc24db9dc5b08d92ac12b112a12a4600a6ede42faf14cf6df08d");
  assert.equal(bare.recurring, null);
  assert.equal(googleEventKeys(CALENDAR, { eventId: "4kq0l1v3s9example", singleEvent: true }).recurring, false);
});

test("original start times need an offset unless they are all-day dates", () => {
  assert.equal(originalStartMillis({ date: "2026-10-20" }), Date.UTC(2026, 9, 20));
  assert.equal(originalStartMillis(1793124000000), 1793124000000);
  assert.throws(() => originalStartMillis("2026-10-20T15:00:00"), RecordError);
  assert.throws(() => originalStartMillis({}), RecordError);
});

test("calendar candidates cover the signed-in account and another account's primary calendar", () => {
  const candidates = googleCalendarCandidates("alex@example.com", ["Alex@Example.com"]);
  assert.deepEqual(candidates.map((candidate) => candidate.accountName), ["Alex@Example.com", "alex@example.com"]);
  assert.equal(candidates[1].key, CALENDAR);
  // Shared calendars belong to whichever account syncs them; only signed-in emails are candidates.
  assert.deepEqual(googleCalendarCandidates("team@group.calendar.google.com", ["alex@example.com"]).map((c) => c.accountName), ["alex@example.com"]);
});

test("payloads are validated with the app's limits before anything is written", () => {
  assert.deepEqual(validatePayload("e_" + "a".repeat(64), '{"leadTimes":[30,10],"enabled":true}'), { leadTimes: [30, 10], enabled: true });
  assert.equal(validatePayload("s_" + "a".repeat(64), "null"), null);
  const bad = [
    ["e_" + "a".repeat(64), '{"leadTimes":[10081]}'],
    ["e_" + "a".repeat(64), `{"leadTimes":[${Array(21).fill(1).join(",")}]}`],
    ["e_" + "a".repeat(64), '{"leadTimes":[1.5]}'],
    ["e_" + "a".repeat(64), '{"volume":101}'],
    ["e_" + "a".repeat(64), '{"enabled":"yes"}'],
    ["e_" + "a".repeat(64), '{"vibrationPattern":"' + "x".repeat(101) + '"}'],
    ["e_" + "a".repeat(64), "[1]"],
    ["c_" + "a".repeat(64), '{"overrides":{"travelLeadTimes":[]}}'],
    ["c_" + "a".repeat(64), '{"overrides":{"travelLeadTimes":[0,10,20,30,40]}}'],
    ["c_" + "a".repeat(64), '{"overrides":{"travelLeadTimes":[180]}}'],
    ["c_" + "a".repeat(64), '{"overrides":{"ringThroughDnd":"yes"}}'],
    ["c_" + "a".repeat(64), '{"overrides":{"ringThroughDnd":1}}'],
    ["c_" + "a".repeat(64), '{"selected":"yes"}'],
    ["c_" + "a".repeat(64), "null"],
    ["p_alarm_volume", "101"],
    ["p_snooze_duration_minutes", "0"],
    ["p_respect_dnd", "1"],
    ["p_theme_preference", JSON.stringify("x".repeat(501))],
    ["p_alarms_paused_until", "-2"],
    ["p_alarms_paused_until", "4102444800001"],
    ["p_theme_preference", '"sepia"'],
    ["p_alert_type", '"silent"'],
    ["p_not_synced", "true"],
    ["x_" + "a".repeat(64), "null"],
    ["e_" + "a".repeat(64), `{"vibrationPattern":"${"x".repeat(17000)}"}`],
  ];
  for (const [id, payload] of bad) assert.throws(() => validatePayload(id, payload), RecordError, `${id} ${payload.slice(0, 60)}`);
  assert.deepEqual(validatePayload("c_" + "a".repeat(64), '{"selected":false,"overrides":{"travelLeadTimes":[0,10],"ignoreAllDay":true}}'),
    { selected: false, overrides: { travelLeadTimes: [0, 10], ignoreAllDay: true } });
  // The app writes only true, but false is a valid (kept) value, as kotlinx keeps it.
  assert.equal(encodePayload("c_" + "a".repeat(64), { overrides: { ringThroughDnd: false, rsvpFilter: "all_events", leadTimes: [5] } }),
    '{"overrides":{"leadTimes":[5],"rsvpFilter":"all_events","ringThroughDnd":false}}');
  assert.equal(samePayload("c_" + "a".repeat(64), '{"overrides":{"leadTimes":[10]}}', '{"overrides":{"leadTimes":[10],"ringThroughDnd":null}}'), true);
  for (const [id, value] of [["p_alarm_volume", 100], ["p_alarms_paused_until", -1], ["p_alarms_paused_until", 4102444800000], ["p_respect_dnd", null], ["p_accent_id", "any accent"]]) {
    assert.equal(encodePayload(id, value), JSON.stringify(value));
  }
  assert.throws(() => encodePayload("p_alarm_volume", "loud"), RecordError);
});

test("the Firestore rules accept exactly the synced preferences and the server's snapshot size", () => {
  const fs = require("node:fs");
  const { PREFERENCE_NAMES } = require("../assistant-records");
  const rules = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");
  const ids = /recordId\.matches\('\^\(p_\(([a-z_|]+)\)\|\[cse\]_\[a-f0-9\]\{64\}\)\$'\)/.exec(rules);
  assert.ok(ids, "isRecordId lists the preferences");
  assert.deepEqual(ids[1].split("|").sort(), [...PREFERENCE_NAMES].sort());
  const { MAX_SNAPSHOT_CHARS } = require("../assistant-data");
  assert.match(rules, new RegExp(`data\\.payload is string && data\\.payload\\.size\\(\\) <= ${MAX_SNAPSHOT_CHARS};`));
});

// ---- Skip keywords ------------------------------------------------------------------------------

test("skip keywords pass the app's shared parity cases", () => {
  const { tidySkipKeywords, firstSkipMatch } = require("../assistant-records");
  // Copied from the app repo's ios/Tests/ParityFixtures/alarm-parity-v2.json (kind skipKeyword).
  const cases = [
    [["LUNCH"], "team lunch", "LUNCH"],
    [["art"], "Quarterly party", null],
    [["gym", "lunch"], "Lunch at the gym", "gym"],
    [["gym"], "Standup", null],
    [["focus time"], "Focus \u00a0  time", "focus time"],
    [["strasse"], "Stra\u00dfe sperren", "strasse"],
    [["izin"], "\u0130z\u0131n g\u00fcn\u00fc", "izin"],
    [["\u03a3\u03a5\u039d\u0391\u039d\u03a4\u0397\u03a3"], "\u03c3\u03c5\u03bd\u03b1\u03bd\u03c4\u03b7\u03c2 \u03bf\u03bc\u03b1\u03b4\u03b1\u03c2", "\u03a3\u03a5\u039d\u0391\u039d\u03a4\u0397\u03a3"],
    [["caf\u00e9"], "Cafe\u0301 chat", "caf\u00e9"],
    [["lunch"], "Lu\u200bnch\u200f", "lunch"],
    [["\u6607\u9032"], "\u5b9a\u4f8b\u4f1a\u8b70 \u6607\u9032\u9762\u8ac7", "\u6607\u9032"],
    [[], "Lunch", null],
    [["Lunch"], "Lunches with the team", null],
    [["lunch"], "Lunch, with Alex", "lunch"],
    [["a"], "Planning", null],
    [["a"], "Plan a trip", "a"],
    [["focus  time"], "Focus time today", "focus  time"],
    [["focus time"], "Focus timeline", null],
    [["stand"], "Daily stand-up", "stand"],
    [["alex"], "Alex's 1:1", "alex"],
    [["standup"], "standup2 sync", null],
    [["C++"], "C++20 review", "C++"],
    [["\u4f1a\u8b70"], "\u5b9a\u4f8b\u4f1a\u8b70", "\u4f1a\u8b70"],
    [["mtg"], "\u5b9a\u4f8bMTG", "mtg"],
    [["mtg"], "MTGs", null],
    [["\u0e1b\u0e23\u0e30\u0e0a\u0e38\u0e21"], "\u0e1b\u0e23\u0e30\u0e0a\u0e38\u0e21\u0e17\u0e35\u0e21", "\u0e1b\u0e23\u0e30\u0e0a\u0e38\u0e21"],
    [["\ud68c\uc758"], "\ud68c\uc758\ub294 3\uc2dc", "\ud68c\uc758"],
  ];
  for (const [keywords, title, match] of cases) assert.equal(firstSkipMatch(title, keywords), match, title);
  assert.deepEqual(tidySkipKeywords(["  ", "  Lunch  now ", "LUNCH NOW", "x".repeat(61), "\u200b"]), ["Lunch now"]);
  assert.equal(tidySkipKeywords(Array.from({ length: 32 }, (_, i) => `k${i}`)).length, 30);
});

test("the skip list is validated like the app's limits", () => {
  const ok = (list) => encodePayload("p_skip_event_keywords", JSON.stringify(list));
  assert.equal(ok(["Lunch"]), JSON.stringify('["Lunch"]'));
  assert.equal(ok([]), JSON.stringify("[]"));
  for (const bad of [["  "], ["x".repeat(61)], ["Lunch", "LUNCH"], [" Lunch"], Array.from({ length: 31 }, (_, i) => `k${i}`), [1], { a: 1 }]) {
    assert.throws(() => ok(bad), RecordError, JSON.stringify(bad));
  }
  assert.throws(() => encodePayload("p_skip_event_keywords", "not json"), RecordError);
  assert.equal(encodePayload("p_skip_event_keywords", null), "null");
});

test("keywordExempt is a boolean on an override, and goes last", () => {
  assert.equal(encodePayload(`e_${"a".repeat(64)}`, { keywordExempt: true, enabled: true, leadTimes: [10] }), '{"leadTimes":[10],"enabled":true,"keywordExempt":true}');
  assert.throws(() => encodePayload(`e_${"a".repeat(64)}`, { keywordExempt: "yes" }), RecordError);
});

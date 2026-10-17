"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  RecordError, calendarKey, encodePayload, googleCalendarCandidates, googleEventKeys, occurrenceKey, originalStartMillis,
  parseGoogleEventId, seriesKey, validatePayload,
} = require("../assistant-records");

// docs/ASSISTANT_PROTOCOL.md "Test vectors": the Kotlin app must produce the same keys.
const CALENDAR = "c_42fb4c3a3db8d2bba3e4897484575c76b2c03322bddf69f7dfcd787a6c213d5a";

test("record keys reproduce every protocol test vector", () => {
  assert.equal(calendarKey("com.google", "alex@example.com", "alex@example.com"), CALENDAR);
  assert.equal(calendarKey("com.google", "alex@example.com", "en.usa#holiday@group.v.calendar.google.com"),
    "c_fee33e5026cd74ede2b023b984a72453b4d16a166b50e29d92fdd0af1c561ec9");
  const single = seriesKey(CALENDAR, "4kq0l1v3s9example");
  assert.equal(single, "s_050961489e18b374331b1996aed77c48ac038669dd77a00357129ece44535a7d");
  assert.equal(occurrenceKey(single, null), "e_e41735eed816bc24db9dc5b08d92ac12b112a12a4600a6ede42faf14cf6df08d");
  const recurring = seriesKey(CALENDAR, "7rcurring0example");
  assert.equal(recurring, "s_a4b8d08d97e8a3a8fd964c4e1811abafeb4c2ae465c396f6b6debbbf06929e5f");
  assert.equal(occurrenceKey(recurring, 1793124000000), "e_7b1ec89029a39d5b40d6ffb94cb7187192ac341db9b4f614b97fae4fc623abda");
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
    ["e_" + "a".repeat(64), '{"surprise":1}'],
    ["e_" + "a".repeat(64), "[1]"],
    ["c_" + "a".repeat(64), '{"overrides":{"travelLeadTimes":[]}}'],
    ["c_" + "a".repeat(64), '{"overrides":{"travelLeadTimes":[0,10,20,30,40]}}'],
    ["c_" + "a".repeat(64), '{"overrides":{"travelLeadTimes":[180]}}'],
    ["c_" + "a".repeat(64), '{"selected":"yes"}'],
    ["c_" + "a".repeat(64), "null"],
    ["p_alarm_volume", "101"],
    ["p_snooze_duration_minutes", "0"],
    ["p_respect_dnd", "1"],
    ["p_theme_preference", JSON.stringify("x".repeat(501))],
    ["p_alarms_paused_until", "-2"],
    ["p_not_synced", "true"],
    ["x_" + "a".repeat(64), "null"],
    ["e_" + "a".repeat(64), `{"vibrationPattern":"${"x".repeat(17000)}"}`],
  ];
  for (const [id, payload] of bad) assert.throws(() => validatePayload(id, payload), RecordError, `${id} ${payload.slice(0, 60)}`);
  assert.deepEqual(validatePayload("c_" + "a".repeat(64), '{"selected":false,"overrides":{"travelLeadTimes":[0,10],"ignoreAllDay":true}}'),
    { selected: false, overrides: { travelLeadTimes: [0, 10], ignoreAllDay: true } });
  for (const [id, value] of [["p_alarm_volume", 100], ["p_alarms_paused_until", -1], ["p_alarms_paused_until", 1793124000000], ["p_respect_dnd", null]]) {
    assert.equal(encodePayload(id, value), JSON.stringify(value));
  }
  assert.throws(() => encodePayload("p_alarm_volume", "loud"), RecordError);
});

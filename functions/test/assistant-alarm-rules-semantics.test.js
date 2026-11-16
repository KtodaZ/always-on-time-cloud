"use strict";
// The cloud preview follows the phones' final rule semantics (cma docs/design/alarm-rules-spec.md,
// Android AlarmRules.kt, iOS AlarmRules.swift). One test per point.
const test = require("node:test"),
  assert = require("node:assert/strict");
const { evaluate, preview } = require("../assistant-alarm-rules");
const { eventsOf } = require("../assistant-tools-rules");

const H = 3600000;
const at = (hour) => Date.UTC(2026, 10, 16, 0) + hour * H;
const rule = (when, then = { type: "add_ring", minutes: 60 }, extra = {}) => ({
  enabled: true,
  order: 0,
  when,
  then,
  createdBy: "user",
  createdAt: 0,
  ...extra,
});
const title = (text) => ({ type: "title_contains", text });
const first = { type: "first_of_day" };
const ev = (id, hour, extra = {}) => ({
  id,
  title: "Meeting",
  start: at(hour),
  end: at(hour + 1),
  calendarKey: "c_work",
  eligible: true,
  rings: [{ minutes: 10, label: null, style: "alarm" }],
  ...extra,
});
const minutes = (out, id) => out[id].rings.map((r) => r.minutes);

// Snapshot helpers for eventsOf.
const snap = (events, calendars = [{ key: "c_work", watched: true, leadTimes: [10] }]) => ({
  timeZone: "UTC",
  calendars,
  events: events.map((e) => ({
    seriesKey: null,
    calendarKey: "c_work",
    allDay: false,
    rsvp: null,
    skippedByKeyword: null,
    alarms: [],
    end: e.start + H,
    ...e,
  })),
});
const stored = (v) => JSON.stringify(v);
const pref = (v) => JSON.stringify(JSON.stringify(v));
const byKey = (list) => Object.fromEntries(list.map((e) => [e.id, e]));

test("1. whole days are evaluated; only upcoming events are listed and counted", () => {
  const now = at(9.5);
  const events = [ev("standup", 9), ev("review", 11)]; // standup is in progress
  const rules = { r: rule([first]) };
  const p = preview(events, {}, rules, "UTC", (e) => e.start > now);
  assert.equal(p.totalUpcoming, 1);
  assert.equal(p.changedCount, 0, "the in-progress standup stays the first of the day");
  assert.equal(preview(events, {}, rules, "UTC").changes[0].eventKey, "standup");
});

test("2. all-day events and silent duplicates are never candidates, first of the day or next_after links", () => {
  const events = [
    ev("allday", 0, { title: "Gym", allDay: true, end: at(24) }),
    ev("copy", 7, { title: "Gym", duplicate: true }),
    ev("standup", 9),
  ];
  const out = evaluate(
    events,
    {
      a: rule([first]),
      b: rule([{ type: "next_after", text: "Gym", hours: 6 }], { type: "add_ring", minutes: 30 }),
      c: rule([title("Gym")], { type: "add_ring", minutes: 45 }),
    },
    "UTC",
  );
  assert.deepEqual(minutes(out, "standup"), [60, 10]);
  assert.deepEqual(minutes(out, "allday"), [10]);
  assert.deepEqual(minutes(out, "copy"), [10]);
  // A duplicate doesn't take the "next" slot either.
  const linked = evaluate(
    [ev("gym", 7, { title: "Gym" }), ev("copy", 8, { duplicate: true }), ev("standup", 9)],
    { b: rule([{ type: "next_after", text: "Gym" }]) },
    "UTC",
  );
  assert.deepEqual(minutes(linked, "standup"), [60, 10]);
});

test("3. filtered occurrences are left out entirely (not even a next_after predecessor)", () => {
  const s = snap([
    { eventKey: "e_gym", title: "Gym", start: at(7), rsvp: "DECLINED" },
    { eventKey: "e_party", title: "Party", start: at(0), allDay: true, end: at(24) },
    { eventKey: "e_standup", title: "Standup", start: at(9) },
  ]);
  const events = eventsOf(s, { p_ignore_all_day_events: "true" });
  assert.deepEqual(events.map((e) => e.id), ["e_standup"]);
  const out = evaluate(events, { r: rule([{ type: "next_after", text: "Gym" }]) }, "UTC");
  assert.deepEqual(minutes(out, "e_standup"), [10]);
});

test("4. eligibility: own switch, Skip keywords (with exemptions), calendar selection; rules never revive", () => {
  const s = snap(
    [
      { eventKey: "e_off", title: "Sync", start: at(8), calendarKey: "c_off" },
      { eventKey: "e_lunch", title: "Lunch", start: at(12) },
      { eventKey: "e_exempt", title: "Lunch with Sam", start: at(13.5) },
      { eventKey: "e_hidden", title: "Sync", start: at(15), calendarKey: "c_hidden" },
      { eventKey: "e_after", title: "Review", start: at(17) },
    ],
    [
      { key: "c_work", watched: true, leadTimes: [10] },
      { key: "c_off", watched: true, leadTimes: [10] },
      { key: "c_hidden", watched: true, leadTimes: [10] },
    ],
  );
  const values = {
    c_off: stored({ overrides: { enabled: false } }),
    c_hidden: stored({ selected: false }),
    e_exempt: stored({ keywordExempt: true }),
    p_skip_event_keywords: pref(["Lunch"]),
  };
  const events = byKey(eventsOf(s, values));
  assert.equal(events.e_off.eligible, false);
  assert.equal(events.e_lunch.eligible, false);
  assert.equal(events.e_exempt.eligible, true);
  assert.equal(events.e_exempt.personalChoice, false);
  assert.equal(events.e_hidden.eligible, false);
  const out = evaluate(
    Object.values(events),
    { r: rule([title("Sync")]), l: rule([title("Lunch")], { type: "add_ring", minutes: 30 }) },
    "UTC",
  );
  assert.deepEqual(out.e_off.rings, []);
  assert.deepEqual(out.e_hidden.rings, []);
  assert.deepEqual(out.e_lunch.rings, []);
  assert.deepEqual(minutes(out, "e_exempt"), [30, 10]);
  // An ineligible (keyword-skipped) event still links as a next_after predecessor.
  const linked = evaluate(
    [ev("lunch", 12, { title: "Lunch", eligible: false, rings: [] }), ev("review", 14)],
    { r: rule([{ type: "next_after", text: "Lunch" }]) },
    "UTC",
  );
  assert.deepEqual(minutes(linked, "review"), [60, 10]);
});

test("5. a personal event or series choice beats rules", () => {
  const s = snap([
    { eventKey: "e_own", title: "Meeting", start: at(9) },
    { eventKey: "e_series", seriesKey: "s_weekly", title: "Meeting", start: at(11) },
    { eventKey: "e_plain", title: "Meeting", start: at(13) },
  ]);
  const values = {
    e_own: stored({ leadTimes: [30] }),
    s_weekly: stored({ enabled: true }),
  };
  const events = eventsOf(s, values);
  const out = evaluate(events, { r: rule([title("Meeting")], { type: "dont_ring" }) }, "UTC");
  assert.deepEqual(minutes(out, "e_own"), [30]);
  assert.deepEqual(minutes(out, "e_series"), [10]);
  assert.deepEqual(out.e_plain.rings, []);
});

test("6. dont_ring wins over every add_ring, whatever the order", () => {
  const out = evaluate(
    [ev("a", 9)],
    {
      add: rule([title("Meeting")]),
      off: rule([first], { type: "dont_ring" }, { order: 5 }),
    },
    "UTC",
  );
  assert.deepEqual(out.a.rings, []);
  assert.deepEqual(out.a.silencedByRules, ["off"]);
});

test("7. rings stack and merge: alarm beats notification; rule label beats inherited; rule order breaks ties", () => {
  const base = ev("a", 9, { rings: [{ minutes: 10, label: "Calendar", style: "notification" }] });
  const out = evaluate(
    [base],
    {
      z: rule([title("Meeting")], { type: "add_ring", minutes: 10, label: "Rule one", style: "notification" }),
      y: rule([title("Meeting")], { type: "add_ring", minutes: 10, label: "Rule two", style: "alarm" }, { order: 1 }),
      x: rule([title("Meeting")], { type: "add_ring", minutes: 45, style: "notification" }, { order: 2 }),
    },
    "UTC",
  ).a.rings;
  assert.deepEqual(out.map((r) => [r.minutes, r.label, r.style, r.ruleIds]), [
    [45, null, "notification", ["x"]],
    [10, "Rule one", "alarm", ["z", "y"]],
  ]);
  // Notification + notification stays a notification; a rule without a label keeps the inherited one.
  const quiet = evaluate(
    [base],
    { z: rule([title("Meeting")], { type: "add_ring", minutes: 10, style: "notification" }) },
    "UTC",
  ).a.rings[0];
  assert.deepEqual([quiet.label, quiet.style], ["Calendar", "notification"]);
});

test("8. first_of_day counts only events that would ring, in two steps", () => {
  const gym = ev("gym", 7, { title: "Gym", calendarKey: "c_personal" });
  const standup = ev("standup", 9);
  const later = ev("later", 11);
  // Spec example: the first-of-day silence makes Standup the first event that rings.
  let out = evaluate(
    [gym, standup],
    {
      off: rule([first, { type: "on_calendar", calendarKey: "c_personal" }], { type: "dont_ring" }),
      add: rule([first], undefined, { order: 1 }),
    },
    "UTC",
  );
  assert.deepEqual(out.gym.rings, []);
  assert.deepEqual(minutes(out, "standup"), [60, 10]);
  // Step one: a first-of-day dont_ring looks past events ordinary dont_ring rules silence.
  out = evaluate(
    [gym, standup, later],
    { gymOff: rule([title("Gym")], { type: "dont_ring" }), firstOff: rule([first], { type: "dont_ring" }, { order: 1 }) },
    "UTC",
  );
  assert.deepEqual(out.standup.rings, []);
  assert.deepEqual(minutes(out, "later"), [10]);
  // A personal choice is never silenced by a rule, so it still counts as the first.
  out = evaluate(
    [{ ...gym, personalChoice: true }, standup],
    { gymOff: rule([title("Gym")], { type: "dont_ring" }), add: rule([first], undefined, { order: 1 }) },
    "UTC",
  );
  assert.deepEqual(minutes(out, "gym"), [10]);
  assert.deepEqual(minutes(out, "standup"), [10]);
  // Events with no ring on don't count.
  out = evaluate(
    [ev("noRings", 6, { rings: [] }), ev("allOff", 7, { offMinutes: [10] }), ev("ineligible", 8, { eligible: false }), standup],
    { add: rule([first]) },
    "UTC",
  );
  assert.deepEqual(minutes(out, "standup"), [60, 10]);
  assert.deepEqual(minutes(out, "allOff"), [10]);
});

test("9. next_after links to the first following start on the local day, gap ≤ hours (default 2)", () => {
  const gym = ev("gym", 7, { title: "Gym" });
  const r = { r: rule([{ type: "next_after", text: "Gym" }]) };
  assert.deepEqual(minutes(evaluate([gym, ev("a", 10)], r, "UTC"), "a"), [60, 10]);
  assert.deepEqual(
    minutes(evaluate([gym, ev("a", 10, { start: at(10) + 1, end: at(11) })], r, "UTC"), "a"),
    [10],
  );
  // An event that starts before the gym ends is not "next"; the first start after its end is.
  const out = evaluate([gym, ev("overlap", 7.5), ev("next", 8.5), ev("after", 9)], r, "UTC");
  assert.deepEqual([minutes(out, "overlap"), minutes(out, "next"), minutes(out, "after")], [[10], [60, 10], [10]]);
  // A zero-length predecessor links to the event after it.
  const zero = ev("gym", 7, { title: "Gym", end: at(7) });
  assert.deepEqual(minutes(evaluate([zero, ev("a", 8)], r, "UTC"), "a"), [60, 10]);
});

test("10. ring options come from the tier that owns the lead-time list", () => {
  const s = snap(
    [
      { eventKey: "e_default", title: "A", start: at(8) },
      { eventKey: "e_cal", title: "B", start: at(9), calendarKey: "c_cal" },
      { eventKey: "e_local", title: "C", start: at(10), calendarKey: "c_local" },
      { eventKey: "e_series", seriesKey: "s_x", title: "D", start: at(11) },
      { eventKey: "e_own", title: "E", start: at(12) },
    ],
    [
      { key: "c_work", watched: true, leadTimes: [10, 45] },
      { key: "c_cal", watched: true, leadTimes: [45] },
      { key: "c_local", watched: true, leadTimes: [15] },
    ],
  );
  const values = {
    p_default_lead_times_csv: pref([10, 45]),
    p_default_ring_options: pref({ 45: { label: "Prep", style: "notification" } }),
    c_cal: stored({ overrides: { leadTimes: [45] } }),
    s_x: stored({ leadTimes: [45], ringOptions: { 45: { label: "Series" } } }),
    e_own: stored({ leadTimes: [45] }),
  };
  const events = byKey(eventsOf(s, values));
  const ring = (id) => events[id].rings.find((r) => r.minutes === 45) ?? events[id].rings[0];
  assert.deepEqual(ring("e_default"), { minutes: 45, label: "Prep", style: "notification" });
  assert.deepEqual(ring("e_cal"), { minutes: 45, label: null, style: "alarm" });
  assert.deepEqual(events.e_local.rings, [{ minutes: 15, label: null, style: "alarm" }]);
  assert.deepEqual(ring("e_series"), { minutes: 45, label: "Series", style: "alarm" });
  // A personal occurrence without its own options keeps those of the tier it inherited from.
  assert.deepEqual(ring("e_own"), { minutes: 45, label: "Prep", style: "notification" });
});

test("11. inert rules: unknown vocabulary, invalid, disabled, and beyond the first 30 by order then id", () => {
  const events = [ev("a", 9)];
  const filler = Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [`r${String(i).padStart(2, "0")}`, rule([title("Nothing")], undefined, { order: i })]),
  );
  const off = rule([title("Meeting")], { type: "dont_ring" }, { order: 30 });
  assert.deepEqual(minutes(evaluate(events, { ...filler, zz: off }, "UTC"), "a"), [10]);
  // Ties on order fall back to id: "a0" sorts before the 30th filler and takes effect.
  const tied = { ...filler, a0: { ...off, order: 29 } };
  assert.deepEqual(evaluate(events, tied, "UTC").a.rings, []);
  for (const r of [
    rule([{ type: "future" }]),
    rule([title("Meeting")], { type: "future" }),
    rule([title("Meeting")], { type: "add_ring", minutes: 0 }),
    rule([title("Meeting")], undefined, { enabled: false }),
  ])
    assert.deepEqual(minutes(evaluate(events, { r }, "UTC"), "a"), [10]);
});

test("silent copies are inferred from same title and start, keeping the copy that rings", () => {
  const s = snap([
    { eventKey: "e_b", title: "Standup ", start: at(9), alarms: [{ at: at(8.8), kind: "lead", minutes: 10, source: "app", status: "on" }] },
    { eventKey: "e_a", title: "standup", start: at(9), alarms: [{ at: at(8.8), kind: "lead", minutes: 10, source: "app", status: "off" }] },
    { eventKey: "e_c", title: "Standup", start: at(10) },
  ]);
  const events = byKey(eventsOf(s, {}));
  assert.equal(events.e_b.duplicate, undefined);
  assert.equal(events.e_a.duplicate, true);
  assert.equal(events.e_c.duplicate, undefined);
});

test("keyless snapshot events take part and are listed with a null key", () => {
  const s = snap([
    { eventKey: null, title: "Gym", start: at(7) },
    { eventKey: "e_next", title: "Review", start: at(8) },
  ]);
  const events = eventsOf(s, {});
  const p = preview(events, {}, { r: rule([title("Gym")]) }, "UTC");
  assert.equal(p.changes[0].eventKey, null);
  const linked = evaluate(events, { r: rule([{ type: "next_after", text: "Gym" }]) }, "UTC");
  assert.deepEqual(minutes(linked, "e_next"), [60, 10]);
});

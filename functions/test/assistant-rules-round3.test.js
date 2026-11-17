"use strict";

// Alarm rules Round 3: five new conditions, up to four per rule. The cloud evaluates
// time_of_day and day_of_week; video_link, location and attendees are phone-only (the snapshot
// never carries links, locations or guest lists), so their previews list no events.

const assert = require("node:assert/strict");
const test = require("node:test");

const { evaluate, sentence, phoneOnly, understood } = require("../assistant-alarm-rules");
const { encodePayload, validateRule } = require("../assistant-records");
const { FakeFirestore } = require("../testing/fake-firestore");
const { createToolContext } = require("../assistant-tool-context");
const { TOOLS } = require("../assistant-tools");

const rule = (when, then = { type: "add_ring", minutes: 60 }, extra = {}) => ({
  enabled: true,
  order: 0,
  when,
  then,
  createdBy: "user",
  createdAt: 0,
  ...extra,
});
const RULE_ID = "r_02652016-e79a-47a3-a9b1-891549de8a02";
const at = (iso) => Date.parse(iso);
const ev = (id, startIso, extra = {}) => ({
  id,
  title: "Meeting",
  start: at(startIso),
  end: at(startIso) + 3600000,
  calendarKey: null,
  eligible: true,
  rings: [{ minutes: 10, style: "alarm", label: null }],
  ...extra,
});
const ringed = (out, id) => out[id].rings.some((r) => r.minutes === 60);
const time = (compare, minute) => ({ type: "time_of_day", compare, minute });
const days = (list) => ({ type: "day_of_week", days: list });

test("validation accepts the Round 3 conditions and 1–4 conditions per rule", () => {
  for (const c of [
    time("before", 0),
    time("after", 1439),
    days([1]),
    days([1, 2, 3, 4, 5, 7]),
    { type: "video_link", has: true },
    { type: "video_link", has: false },
    { type: "location", has: false },
    { type: "attendees", compare: "at_least", count: 2 },
    { type: "attendees", compare: "at_most", count: 1 },
    { type: "attendees", compare: "at_most", count: 99 },
  ])
    assert.doesNotThrow(() => validateRule(rule([c])), JSON.stringify(c));
  assert.doesNotThrow(() =>
    validateRule(rule([time("before", 540), days([1, 2]), { type: "video_link", has: true }, { type: "location", has: true }])),
  );
  assert.throws(() => validateRule(rule([])), /structure/);
  assert.throws(
    () => validateRule(rule([time("before", 1), days([1]), { type: "location", has: true }, { type: "video_link", has: true }, { type: "first_of_day" }])),
    /structure/,
  );
});

test("validation rejects out-of-range, unsorted, repeated and mistyped fields", () => {
  const bad = [
    time("before", 1440),
    time("before", -1),
    time("sooner", 60),
    { type: "time_of_day", compare: "before" },
    { type: "time_of_day", compare: "before", minute: 1.5 },
    days([]),
    days([0]),
    days([8]),
    days([2, 1]),
    days([1, 1]),
    days([1, 2, 3, 4, 5, 6, 7]),
    { type: "day_of_week" },
    { type: "day_of_week", days: "1" },
    { type: "video_link" },
    { type: "location", has: "yes" },
    { type: "attendees", compare: "at_least", count: 1 },
    { type: "attendees", compare: "at_least", count: 100 },
    { type: "attendees", compare: "at_most", count: 0 },
    { type: "attendees", compare: "before", count: 3 },
    { type: "attendees", compare: "at_least" },
  ];
  for (const c of bad) assert.throws(() => validateRule(rule([c])), JSON.stringify(c));
  for (const type of ["time_of_day", "day_of_week", "video_link", "location", "attendees"]) {
    const ok = { time_of_day: time("before", 60), day_of_week: days([6]), video_link: { type, has: true }, location: { type, has: true }, attendees: { type, compare: "at_least", count: 3 } }[type];
    assert.throws(() => validateRule(rule([ok, { ...ok }])), /duplicate/, type);
  }
});

test("canonical payloads put the Round 3 fields after hours, nulls out, has:false kept", () => {
  const scrambled = rule([
    { count: 3, compare: "at_most", type: "attendees", text: null },
    { minute: 540, compare: "before", type: "time_of_day" },
    { days: [6, 7], type: "day_of_week" },
    { has: false, type: "video_link" },
  ]);
  assert.equal(
    encodePayload(RULE_ID, scrambled),
    '{"enabled":true,"order":0,"when":[{"type":"attendees","compare":"at_most","count":3},{"type":"time_of_day","compare":"before","minute":540},{"type":"day_of_week","days":[6,7]},{"type":"video_link","has":false}],"then":{"type":"add_ring","minutes":60},"createdBy":"user","createdAt":0}',
  );
});

test("a rule from a newer app with unknown vocabulary stays valid but isn't understood", () => {
  const future = rule([{ type: "organizer", has: true }]);
  assert.doesNotThrow(() => validateRule(future));
  assert.equal(understood(future), false);
  assert.equal(understood(rule([{ type: "attendees", compare: "at_least", count: 2 }])), true);
});

test("time_of_day compares the local start: before is exclusive, after is inclusive", () => {
  const events = [ev("early", "2026-11-16T16:59:00Z"), ev("nine", "2026-11-16T17:00:00Z"), ev("late", "2026-11-16T17:01:00Z")];
  const zone = "America/Los_Angeles"; // 08:59, 09:00, 09:01
  const before = evaluate(events, { r: rule([time("before", 540)]) }, zone);
  assert.deepEqual(["early", "nine", "late"].map((id) => ringed(before, id)), [true, false, false]);
  const after = evaluate(events, { r: rule([time("after", 540)]) }, zone);
  assert.deepEqual(["early", "nine", "late"].map((id) => ringed(after, id)), [false, true, true]);
});

test("time_of_day uses the user's zone across midnight and DST changes", () => {
  const zone = "America/Los_Angeles";
  const midnight = ev("mid", "2026-11-16T08:00:00Z"); // 00:00 PST, never "24:00"
  assert.equal(ringed(evaluate([midnight], { r: rule([time("before", 1)]) }, zone), "mid"), true);
  // Fall back, Nov 1 2026: 01:30 happens twice (PDT then PST); both are minute 90.
  const first = ev("pdt", "2026-11-01T08:30:00Z"), second = ev("pst", "2026-11-01T09:30:00Z");
  const fall = evaluate([first, second], { r: rule([time("before", 120)]) }, zone);
  assert.equal(ringed(fall, "pdt") && ringed(fall, "pst"), true);
  assert.equal(ringed(evaluate([first, second], { r: rule([time("after", 91)]) }, zone), "pst"), false);
  // Spring forward, Mar 8 2026: 01:59 PST is followed by 03:00 PDT.
  const springBefore = ev("a", "2026-03-08T09:59:00Z"), springAfter = ev("b", "2026-03-08T10:00:00Z");
  const spring = evaluate([springBefore, springAfter], { r: rule([time("after", 180)]) }, zone);
  assert.deepEqual([ringed(spring, "a"), ringed(spring, "b")], [false, true]);
  // The same instant is a different local time elsewhere.
  const same = ev("x", "2026-11-16T17:00:00Z");
  assert.equal(ringed(evaluate([same], { r: rule([time("before", 600)]) }, "America/Los_Angeles"), "x"), true); // 09:00
  assert.equal(ringed(evaluate([same], { r: rule([time("before", 600)]) }, "Europe/Berlin"), "x"), false); // 18:00
});

test("day_of_week matches the local ISO weekday, not the UTC one", () => {
  const zone = "America/Los_Angeles";
  const sundayNight = ev("sun", "2026-11-16T06:30:00Z"); // Sun Nov 15, 22:30 PST (Monday in UTC)
  const monday = ev("mon", "2026-11-16T17:00:00Z");
  const out = evaluate([sundayNight, monday], { r: rule([days([7])]) }, zone);
  assert.deepEqual([ringed(out, "sun"), ringed(out, "mon")], [true, false]);
  const weekdays = evaluate([sundayNight, monday], { r: rule([days([1, 2, 3, 4, 5])]) }, zone);
  assert.deepEqual([ringed(weekdays, "sun"), ringed(weekdays, "mon")], [false, true]);
  // Ahead of UTC: Sunday 20:00Z is already Monday 07:00 in Sydney.
  const sydney = evaluate([ev("syd", "2026-11-15T20:00:00Z")], { r: rule([days([1])]) }, "Australia/Sydney");
  assert.equal(ringed(sydney, "syd"), true);
  // Fall back day (Nov 1 2026 is a Sunday) keeps both repeated hours on Sunday.
  const fall = evaluate([ev("a", "2026-11-01T08:30:00Z"), ev("b", "2026-11-01T09:30:00Z")], { r: rule([days([7])]) }, zone);
  assert.equal(ringed(fall, "a") && ringed(fall, "b"), true);
});

test("conditions combine: all must hold, and first_of_day looks only at events meeting the others", () => {
  const zone = "America/Los_Angeles";
  const events = [
    ev("sat", "2026-11-14T17:00:00Z"), // Saturday 09:00
    ev("mon8", "2026-11-16T16:00:00Z"), // Monday 08:00
    ev("mon9", "2026-11-16T17:30:00Z"), // Monday 09:30
    ev("tue8", "2026-11-17T16:30:00Z"), // Tuesday 08:30
  ];
  const weekdayMorning = evaluate(events, { r: rule([days([1, 2, 3, 4, 5]), time("before", 540)]) }, zone);
  assert.deepEqual(events.map((e) => ringed(weekdayMorning, e.id)), [false, true, false, true]);
  // First of the day among events starting before 9:30 on a weekday: Monday's 08:00 only.
  const first = evaluate(events, { r: rule([{ type: "first_of_day" }, days([1]), time("before", 570)]) }, zone);
  assert.deepEqual(events.map((e) => ringed(first, e.id)), [false, true, false, false]);
  // Events that don't meet the other condition don't count as "first".
  const firstAfter = evaluate(events, { r: rule([{ type: "first_of_day" }, time("after", 540)]) }, zone);
  assert.equal(ringed(firstAfter, "mon9"), true);
  assert.equal(ringed(firstAfter, "mon8"), false);
});

test("phone-only conditions are recognised and take no part in the cloud evaluation", () => {
  const phoneRules = [
    rule([{ type: "video_link", has: true }]),
    rule([days([6, 7]), { type: "location", has: false }]),
    rule([time("before", 540), days([1]), { type: "attendees", compare: "at_least", count: 5 }]),
  ];
  phoneRules.forEach((r) => assert.equal(phoneOnly(r), true));
  assert.equal(phoneOnly(rule([days([6, 7]), time("after", 60)])), false);
  assert.equal(phoneOnly(null), false);
  const out = evaluate([ev("a", "2026-11-16T17:00:00Z")], { r: phoneRules[0], q: phoneRules[1] }, "UTC");
  assert.equal(out.a.rings.length, 1);
});

test("sentences follow the copy file", () => {
  const calendars = [{ key: "c_work", name: "Work" }];
  const cases = [
    [rule([days([1, 2, 3, 4, 5]), time("before", 540)]), "When an event is on weekdays and starts before 9:00 AM → add a ring 1 hour before"],
    [rule([days([6, 7])], { type: "dont_ring" }), "When an event is on weekends → don't ring"],
    [rule([days([1])]), "When an event is on Monday → add a ring 1 hour before"],
    [rule([days([1, 3, 5])]), "When an event is on Mon, Wed, Fri → add a ring 1 hour before"],
    [rule([time("after", 0)]), "When an event starts after 12:00 AM → add a ring 1 hour before"],
    [rule([time("after", 13 * 60 + 5)]), "When an event starts after 1:05 PM → add a ring 1 hour before"],
    [rule([time("before", 720)]), "When an event starts before 12:00 PM → add a ring 1 hour before"],
    [rule([{ type: "video_link", has: true }], { type: "add_ring", minutes: 5, style: "notification" }), "When an event has a video link → add a ring 5 min before · notification"],
    [rule([{ type: "video_link", has: false }]), "When an event has no video link → add a ring 1 hour before"],
    [rule([{ type: "location", has: true }], { type: "add_ring", minutes: 30, label: "Pack up" }), "When an event has a location → add a ring 30 min before · Pack up"],
    [rule([{ type: "location", has: false }], { type: "dont_ring" }), "When an event has no location → don't ring"],
    [rule([{ type: "attendees", compare: "at_least", count: 5 }]), "When an event has 5 or more people → add a ring 1 hour before"],
    [rule([{ type: "attendees", compare: "at_most", count: 4 }]), "When an event has 4 or fewer people → add a ring 1 hour before"],
    [rule([{ type: "attendees", compare: "at_most", count: 1 }], { type: "dont_ring" }), "When an event has just you → don't ring"],
    [rule([{ type: "title_contains", text: "Interview" }]), "When an event has Interview in the title → add a ring 1 hour before"],
    [rule([{ type: "on_calendar", calendarKey: "c_work" }, { type: "first_of_day" }], { type: "dont_ring" }), "When an event is on Work and is the first of the day → don't ring"],
    [rule([{ type: "next_after", text: "Gym" }], { type: "add_ring", minutes: 45 }), "When an event is the next one after Gym, within 2 hours → add a ring 45 min before"],
    [rule([{ type: "next_after", text: "Gym", hours: 1 }], { type: "dont_ring" }), "When an event is the next one after Gym, within 1 hour → don't ring"],
    [rule([{ type: "on_calendar", calendarKey: "c_gone" }], { type: "dont_ring" }), "When an event is on an unavailable calendar → don't ring"],
  ];
  for (const [r, want] of cases) assert.equal(sentence(r, calendars), want);
});

// --- Tools: preview_rule / apply_rule / list_rules ---------------------------------------------

function setup(extraEvents = []) {
  const db = new FakeFirestore();
  const now = Date.parse("2026-11-16T12:00:00Z");
  db.now = () => now;
  const ctx = createToolContext({
    db,
    uid: "alice",
    grant: { grantId: "g1", clientName: "Claude", assistant: "claude", scopes: ["alarms.read", "alarms.write"] },
    now: () => now,
    logger: {},
    origin: "https://example.com",
  });
  ctx.pushAllowed = async () => true;
  const work = `c_${"c".repeat(64)}`;
  const event = (n, startIso, title) => ({
    eventKey: `e_${String(n).repeat(64)}`,
    seriesKey: `s_${String(n).repeat(64)}`,
    calendarKey: work,
    title,
    start: at(startIso),
    end: at(startIso) + 3600000,
    allDay: false,
    alarms: [{ kind: "lead", minutes: 10, at: at(startIso) - 600000, source: "calendar", status: "on" }],
  });
  const payload = {
    timeZone: "America/Los_Angeles",
    device: "Test phone",
    calendars: [{ key: work, name: "Work", watched: true, leadTimes: [10] }],
    events: [
      event(1, "2026-11-17T16:30:00Z", "Standup"), // Tuesday 08:30
      event(2, "2026-11-17T20:00:00Z", "Review"), // Tuesday 12:00
      event(3, "2026-11-21T17:00:00Z", "Brunch"), // Saturday 09:00
      ...extraEvents,
    ],
  };
  db.documents.set("accounts/alice", { active: true, schemaVersion: 1 });
  db.documents.set("accounts/alice/assistantSnapshots/phone", { publishedAt: new Date(now), payload: JSON.stringify(payload), schemaVersion: 1 });
  const call = (name, args = {}) => TOOLS.find((t) => t.name === name).handler(ctx, args);
  return { db, call, ctx };
}

test("preview_rule lists events for time and weekday rules in the snapshot's zone", async () => {
  const { call } = setup();
  const p = await call("preview_rule", {
    operation: "create",
    rule: {
      when: [{ type: "day_of_week", days: [5, 1, 2, 3, 4, 1] }, { type: "time_of_day", compare: "before", minute: 540 }],
      then: { type: "add_ring", minutes: 60 },
    },
  });
  assert.equal(p.data.previewMode, "events");
  assert.equal(p.data.sentence, "When an event is on weekdays and starts before 9:00 AM → add a ring 1 hour before");
  assert.deepEqual(p.data.changes.map((c) => c.title), ["Standup"]);
  assert.equal(p.data.changedCount, 1);
  assert.match(p.text, /Standup/);
  assert.match(p.data.previewId, /^pr_/);
});

for (const [name, when] of [
  ["video_link", [{ type: "video_link", has: true }]],
  ["location", [{ type: "location", has: false }]],
  ["attendees", [{ type: "attendees", compare: "at_least", count: 5 }]],
  ["mixed with an evaluable condition", [{ type: "day_of_week", days: [6, 7] }, { type: "video_link", has: true }]],
]) {
  test(`preview_rule for ${name} validates and returns the sentence but lists no events`, async () => {
    const { call, db } = setup();
    const p = await call("preview_rule", { operation: "create", rule: { when, then: { type: "add_ring", minutes: 5, style: "notification" } } });
    assert.equal(p.data.previewMode, "phone_only");
    assert.equal(p.data.changes, null);
    assert.equal(p.data.changedCount, null);
    assert.equal(p.data.silencedEvents, null);
    assert.equal(p.data.largeShare, null);
    assert.match(p.data.phoneOnlyNote, /phone will show which events match|will show which events match/);
    assert.match(p.text, /show which events match/);
    assert.match(p.data.sentence, /^When an event .* → add a ring 5 min before · notification$/);
    assert.match(p.data.previewId, /^pr_/);
    // No event facts of any kind reached Firestore besides the preview itself.
    const stored = db.documents.get(`accounts/alice/assistantRulePreviews/${p.data.previewId}`);
    assert.ok(stored);
    assert.equal(JSON.stringify(stored).includes("Standup"), false);
    const applied = await call("apply_rule", { previewId: p.data.previewId });
    assert.equal(applied.data.changed, true);
    assert.equal(applied.data.alert ?? null, null);
    const listed = await call("list_rules");
    assert.equal(listed.data.rules.length, 1);
    assert.equal(listed.data.rules[0].sentence, p.data.sentence);
  });
}

test("a phone-only don't-ring rule raises the risky-change alert without a silenced count", async () => {
  const { call } = setup();
  const p = await call("preview_rule", { operation: "create", rule: { when: [{ type: "attendees", compare: "at_most", count: 1 }], then: { type: "dont_ring" } } });
  assert.equal(p.data.previewMode, "phone_only");
  const a = await call("apply_rule", { previewId: p.data.previewId });
  assert.equal(a.data.alert, "alarms_off");
  const id = p.data.ruleId;
  const off = await call("preview_rule", { operation: "disable", ruleId: id });
  assert.equal(off.data.previewMode, "phone_only");
  assert.equal((await call("apply_rule", { previewId: off.data.previewId })).data.alert ?? null, null);
  const del = await call("preview_rule", { operation: "delete", ruleId: id });
  assert.equal(del.data.previewMode, "phone_only");
});

test("preview_rule refuses repeated types, stray fields and invalid values", async () => {
  const { call } = setup();
  const create = (when) => call("preview_rule", { operation: "create", rule: { when, then: { type: "dont_ring" } } });
  await assert.rejects(create([{ type: "day_of_week", days: [1] }, { type: "day_of_week", days: [2] }]), /at most once/);
  await assert.rejects(create([{ type: "title_contains", text: "a" }, { type: "title_contains", text: "b" }]), /at most once/);
  await assert.rejects(create([{ type: "video_link", has: true, minute: 5 }]), /does not take minute/);
  await assert.rejects(create([{ type: "attendees", compare: "at_least", count: 1 }]), /matches everything/);
  await assert.rejects(create([{ type: "video_link" }]), /has true or false/);
  await assert.rejects(create([{ type: "day_of_week", days: [1, 2, 3, 4, 5, 6, 7] }]));
  await assert.rejects(create([{ type: "time_of_day", compare: "before", minute: 1440 }]));
  await assert.rejects(create([{ type: "first_of_day" }, { type: "time_of_day", compare: "before", minute: 60 }, { type: "day_of_week", days: [1] }, { type: "location", has: true }, { type: "attendees", compare: "at_most", count: 2 }]));
});

test("tool schemas and server instructions document the new conditions", () => {
  const { INSTRUCTIONS } = require("../assistant-tools");
  const preview = TOOLS.find((t) => t.name === "preview_rule");
  for (const word of ["time_of_day", "day_of_week", "video_link", "location", "attendees", "phone_only"])
    assert.match(preview.description, new RegExp(word));
  assert.match(TOOLS.find((t) => t.name === "list_rules").description, /attendees/);
  assert.match(INSTRUCTIONS, /a video link, a location or a guest count/);
  assert.match(INSTRUCTIONS, /phone will show/);
});

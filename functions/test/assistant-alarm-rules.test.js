"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { evaluate, preview } = require("../assistant-alarm-rules");
const {
  validateRule,
  encodePayload,
  canonicalRingOptions,
} = require("../assistant-records");
const rule = (when, then = { type: "add_ring", minutes: 45 }, extra = {}) => ({
  enabled: true,
  order: 0,
  when,
  then,
  createdBy: "user",
  createdAt: 0,
  ...extra,
});
const title = (text) => ({ type: "title_contains", text });
const event = (id, hour, extra = {}) => ({
  id,
  title: "Meeting",
  start: Date.UTC(2026, 10, 15, hour),
  end: Date.UTC(2026, 10, 15, hour + 1),
  calendarKey: "c_work",
  eligible: true,
  rings: [{ minutes: 10, style: "alarm", label: null }],
  ...extra,
});
test("first-of-day restricts to other conditions, eligible ringing non-all-day events and local days", () => {
  const events = [
    event("a", 1, { calendarKey: "c_home" }),
    event("b", 2, { eligible: false }),
    event("c", 3, { allDay: true }),
    event("d", 4, { rings: [] }),
    event("e", 5),
    event("f", 6),
    event("g", 25),
  ];
  const r = {
    r: rule([
      { type: "first_of_day" },
      { type: "on_calendar", calendarKey: "c_work" },
    ]),
  };
  const out = evaluate(events, r, "UTC");
  for (const id of ["e", "g"]) assert.equal(out[id].rings[0].minutes, 45);
  for (const id of ["a", "b", "c", "f"]) assert.equal(out[id].rings.length, 1);
  assert.equal(
    evaluate(
      [event("a", 7), event("b", 9)],
      { r: rule([{ type: "first_of_day" }]) },
      "America/Los_Angeles",
    ).b.rings.length,
    2,
  );
});
test("whole word match, unknown vocabulary inert, disabled rules inert", () => {
  const events = [
    event("a", 10, { title: "Team lunch" }),
    event("b", 11, { title: "Lunches" }),
  ];
  const out = evaluate(events, { r: rule([title("Lunch")]) }, "UTC");
  assert.equal(out.a.rings.length, 2);
  assert.equal(out.b.rings.length, 1);
  for (const r of [
    rule([{ type: "future" }]),
    rule([title("Lunch")], { type: "future" }),
    rule([title("Lunch")], undefined, { enabled: false }),
  ])
    assert.equal(evaluate(events, { r }, "UTC").a.rings.length, 1);
});
test("next-after uses end gap inclusive, first start after predecessor, same local day", () => {
  const gym = event("gym", 7, { title: "Gym" });
  const r = { r: rule([{ type: "next_after", text: "Gym", hours: 2 }]) };
  for (const hour of [8, 10])
    assert.equal(evaluate([gym, event("a", hour)], r, "UTC").a.rings.length, 2);
  assert.equal(
    evaluate([gym, event("a", 10, { start: gym.end + 7200001 })], r, "UTC").a
      .rings.length,
    1,
  );
  assert.equal(
    evaluate([gym, event("first", 9), event("later", 10)], r, "UTC").later.rings
      .length,
    1,
  );
  assert.equal(
    evaluate([event("gym", 23, { title: "Gym" }), event("a", 25)], r, "UTC").a
      .rings.length,
    1,
  );
});
test("personal event/series choices win; dont-ring wins, inherited-off events stay off", () => {
  const r = {
    a: rule([title("Meeting")]),
    b: rule([title("Meeting")], { type: "dont_ring" }),
  };
  const out = evaluate(
    [
      event("a", 10),
      event("b", 11, { personalChoice: true }),
      event("c", 12, { eligible: false, rings: [] }),
    ],
    r,
    "UTC",
  );
  assert.deepEqual(out.a.silencedByRules, ["b"]);
  assert.equal(out.a.rings.length, 0);
  assert.equal(out.b.rings.length, 1);
  assert.equal(out.c.rings.length, 0);
});
test("added rings stack, alarm beats notification, first rule label wins inherited label", () => {
  const r = {
    b: rule(
      [title("Meeting")],
      { type: "add_ring", minutes: 10, label: "Second", style: "alarm" },
      { order: 1 },
    ),
    a: rule([title("Meeting")], {
      type: "add_ring",
      minutes: 10,
      label: "First",
      style: "notification",
    }),
  };
  const out = evaluate([event("a", 10)], r, "UTC").a.rings[0];
  assert.equal(out.style, "alarm");
  assert.equal(out.label, "First");
  assert.deepEqual(out.ruleIds, ["a", "b"]);
});
test("preview evaluates complete outcomes including delete, and strict large-share boundary", () => {
  const events = Array.from({ length: 10 }, (_, i) =>
    event(String(i), 10 + i, { title: i < 6 ? "Lunch" : "Meeting" }),
  );
  const r = { a: rule([title("Lunch")], { type: "dont_ring" }) };
  const p = preview(events, {}, r, "UTC");
  assert.equal(p.silencedCount, 6);
  assert.equal(p.largeShare, true);
  assert.equal(preview(events, r, {}, "UTC").changes.length, 6);
  assert.equal(preview(events.slice(1), {}, r, "UTC").largeShare, false);
});
test("model validation, UTF-16 label limit, ring option canonical fields and unknown retention", () => {
  assert.doesNotThrow(() => validateRule(rule([title(" Lunch ")])));
  assert.throws(() => validateRule(rule([title("   ")])));
  assert.throws(() =>
    validateRule(rule([{ type: "next_after", text: "Gym", hours: 7 }])),
  );
  assert.throws(() =>
    validateRule(rule([{ type: "first_of_day" }, { type: "first_of_day" }])),
  );
  assert.throws(() =>
    validateRule(rule([title("Lunch")], { type: "add_ring", minutes: 0 })),
  );
  assert.throws(() =>
    canonicalRingOptions({ 10: { label: "😀".repeat(21) } }, [10]),
  );
  assert.deepEqual(
    canonicalRingOptions(
      {
        10: { style: "alarm" },
        45: { style: "notification", label: "Prepare", future: 7 },
        90: { label: "stale" },
      },
      [10, 45],
    ),
    { 45: { label: "Prepare", style: "notification", future: 7 } },
  );
  assert.throws(() => encodePayload("p_default_ring_options", "[]"));
});

test("snapshot preserves rule provenance, label/style and bare UUIDs", () => {
  const { normalizeSnapshot } = require("../assistant-snapshot");
  const id = "02652016-e79a-47a3-a9b1-891549de8a02";
  const s = normalizeSnapshot({
    publishedAt: 1,
    payload: {
      events: [
        {
          start: 200,
          end: 300,
          silencedByRules: [id],
          alarms: [
            {
              at: 100,
              source: "rule",
              ruleIds: [id, `r_${id}`],
              style: "notification",
              label: "Prepare",
            },
          ],
        },
      ],
    },
  });
  assert.deepEqual(s.events[0].silencedByRules, [id]);
  assert.deepEqual(s.events[0].alarms[0].ruleIds, [id, `r_${id}`]);
  assert.equal(s.events[0].alarms[0].style, "notification");
  assert.equal(s.events[0].alarms[0].label, "Prepare");
});

test("risky rule APNs alerts carry the named rule sentence while keeping Undo category", () => {
  const { buildAssistantApnsRequest } = require("../assistant-push");
  const text = "Claude added a rule: Don't ring for Lunch on Work · 3 events";
  const { body } = buildAssistantApnsRequest({
    type: "sync",
    data: { changeId: "ch_test" },
    deviceId: "phone",
    at: 0,
    alert: "alarms_off",
    assistant: "Claude",
    ruleAlert: { text },
  });
  const payload = JSON.parse(body);
  assert.equal(payload.aps.alert.body, text);
  assert.equal(payload.aps.category, "AOT_ASSISTANT_CHANGE");
});

test("dont-ring previews silence travel rings too and delete restores their actual times", () => {
  const events = [
    event("a", 10, {
      rings: [],
      travelRings: [
        { kind: "travel", minutes: 10, at: Date.UTC(2026, 10, 15, 9) },
      ],
    }),
  ];
  const rules = { a: rule([title("Meeting")], { type: "dont_ring" }) };
  assert.equal(preview(events, {}, rules, "UTC").silencedCount, 1);
  const restored = preview(events, rules, {}, "UTC").changes[0].after.rings;
  assert.equal(restored[0].kind, "travel");
  assert.equal(restored[0].at, events[0].travelRings[0].at);
});

test("next_after scales and matches only the first event after, same day, within the gap", () => {
  const { evaluate, sentence } = require("../assistant-alarm-rules");
  const h = 3600000;
  const base = Date.UTC(2026, 10, 16, 16); // 08:00 Los Angeles
  const ev = (id, title, startH, endH) => ({
    id, title, start: base + startH * h, end: base + endH * h,
    calendarKey: null, rings: [{ minutes: 10 }], eligible: true,
  });
  const events = [
    ev("gym", "Gym", 4, 5), ev("a", "Design review", 6, 7), ev("b", "1:1", 8, 9),
    ev("late", "Late call", 9.5, 10),
  ];
  const rule = {
    enabled: true, order: 0, when: [{ type: "next_after", text: "Gym", hours: 2 }],
    then: { type: "add_ring", minutes: 45 }, createdBy: "user", createdAt: 0,
  };
  const out = evaluate(events, { r1: rule }, "America/Los_Angeles");
  assert.deepEqual(out.a.rings.map((r) => r.minutes), [45, 10]);
  assert.deepEqual(out.b.rings.map((r) => r.minutes), [10]);
  const far = evaluate([ev("gym", "Gym", 1, 2), ev("x", "Standup", 4.5, 5)], { r1: rule }, "America/Los_Angeles");
  assert.deepEqual(far.x.rings.map((r) => r.minutes), [10]);
  const many = Array.from({ length: 600 }, (_, i) => ev(`e${i}`, i % 5 ? "Meeting" : "Gym", i * 0.2, i * 0.2 + 0.1));
  const t0 = Date.now();
  evaluate(many, { r1: rule }, "America/Los_Angeles");
  assert.ok(Date.now() - t0 < 2000);
  assert.match(sentence({ ...rule, then: { type: "add_ring", minutes: 1440 } }), /1 day before/);
  assert.match(sentence({ ...rule, then: { type: "add_ring", minutes: 90 } }), /90 min before/);
});

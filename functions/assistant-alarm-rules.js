"use strict";
const { firstSkipMatch, validateRule } = require("./assistant-records");
const CONDITIONS = [
  "title_contains",
  "on_calendar",
  "first_of_day",
  "next_after",
];
const understood = (r) =>
  r.when.every((c) => CONDITIONS.includes(c.type)) &&
  ["add_ring", "dont_ring"].includes(r.then.type);
function leadText(minutes) {
  if (minutes % 1440 === 0) return minutes === 1440 ? "1 day" : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
  return `${minutes} min`;
}
function sentence(rule, calendars = []) {
  const conditions = rule.when.map((c) =>
    c.type === "title_contains"
      ? c.text
      : c.type === "on_calendar"
        ? `on ${calendars.find((k) => k.key === c.calendarKey)?.name ?? c.calendarKey}`
        : c.type === "first_of_day"
          ? "the first event of the day"
          : c.type === "next_after"
            ? `the next event within ${c.hours ?? 2} hours after ${c.text}`
            : "an unsupported condition",
  );
  return rule.then.type === "dont_ring"
    ? `Don't ring for ${conditions.join(" ")} `.trim()
    : rule.then.type === "add_ring"
      ? `Add a ring ${leadText(rule.then.minutes)} before ${conditions.join(" ")}${rule.then.label ? ` · ${rule.then.label}` : ""}${rule.then.style === "notification" ? " · notification" : ""}`
      : "Unsupported rule";
}
const MAX_RULES = 30;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const orderOf = (r) => (Number.isFinite(r?.order) ? r.order : Infinity);
/**
 * The rules that take effect: the first 30 by `order`, then id (stored-but-extra rules stay
 * inert), keeping those that are on, valid and use only known vocabulary.
 */
function activeRules(rules) {
  return Object.entries(rules ?? {})
    .sort(([a, x], [b, y]) => orderOf(x) - orderOf(y) || cmp(a, b))
    .slice(0, MAX_RULES)
    .filter(([, r]) => {
      try {
        validateRule(r);
      } catch {
        return false;
      }
      return r.enabled && understood(r);
    });
}
const isFirstOfDay = (r) => r.when.some((c) => c.type === "first_of_day");
/**
 * Pure equivalent of the phones' AlarmRuleEvaluator (Android AlarmRules.kt, iOS AlarmRules.swift).
 *
 * `events` should be whole local days of events that still exist (callers leave out cancelled,
 * deleted, superseded and RSVP/all-day-filtered occurrences entirely). Each event:
 * `{id, title, start, end, calendarKey, rings: [{minutes, label, style}], eligible, allDay,
 * personalChoice, duplicate, offMinutes, travelRings}`. `rings` are the usual rings before any
 * rule; `eligible` is the event's own switch, Skip keywords and the calendar selection;
 * `duplicate` marks a silent copy; `offMinutes` are usual minutes turned off one by one.
 */
function evaluate(events, rules, zone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const days = new Map();
  const day = (e) => {
    if (!days.has(e.id)) days.set(e.id, fmt.format(e.start));
    return days.get(e.id);
  };
  const endOf = (e) => (Number.isFinite(e.end) ? e.end : e.start);
  const byStart = (a, b) => a.start - b.start || cmp(String(a.id), String(b.id));
  const ordered = [...events].sort(byStart);
  // All-day events and silent duplicate copies take no part in matching or linking.
  const matchable = ordered.filter((e) => !e.allDay && !e.duplicate);
  // Link each predecessor to the first following start on its local day (a sweep over end
  // times), independently of eligibility, as the phones do (zero-duration events included).
  const predecessors = new Map();
  const link = (id, p) => {
    if (!predecessors.has(id)) predecessors.set(id, []);
    predecessors.get(id).push(p);
  };
  const byDay = new Map();
  for (const e of matchable) {
    if (!byDay.has(day(e))) byDay.set(day(e), []);
    byDay.get(day(e)).push(e);
  }
  for (const starts of byDay.values()) {
    const ends = [...starts].sort(
      (a, b) => endOf(a) - endOf(b) || cmp(String(a.id), String(b.id)),
    );
    let cursor = 0;
    starts.forEach((next, index) => {
      while (cursor < ends.length && endOf(ends[cursor]) <= next.start) {
        const previous = ends[cursor++];
        const target = previous.id !== next.id ? next : starts[index + 1];
        if (target) link(target.id, previous);
      }
    });
  }
  const ordinary = (c, e) => {
    if (c.type === "title_contains") return !!firstSkipMatch(e.title, [c.text]);
    if (c.type === "on_calendar")
      return e.calendarKey != null && e.calendarKey === c.calendarKey;
    if (c.type === "first_of_day") return true;
    if (c.type === "next_after")
      return (predecessors.get(e.id) ?? []).some(
        (p) =>
          e.start - endOf(p) <= (c.hours ?? 2) * 3600000 &&
          !!firstSkipMatch(p.title, [c.text]),
      );
    return false;
  };
  const active = activeRules(rules);
  const candidates = (r) =>
    matchable.filter((e) => e.eligible && r.when.every((c) => ordinary(c, e)));
  const matches = new Map();
  for (const [id, r] of active)
    if (!isFirstOfDay(r)) matches.set(id, new Set(candidates(r).map((e) => e.id)));
  // "First of the day" counts only events that would ring: usual rings with at least one on, and
  // not silenced by a don't-ring rule (rules never touch a personal choice). Two steps keep it
  // free of circularity: first-of-day don't-ring rules look past events the ordinary don't-ring
  // rules silence; first-of-day add-ring rules then look past every silenced event.
  const ringsUsually = (e) => {
    const off = new Set(e.offMinutes ?? []);
    return e.eligible && !e.duplicate && e.rings.some((r) => !off.has(r.minutes));
  };
  const silencedByAny = new Set();
  for (const [id, r] of active)
    if (!isFirstOfDay(r) && r.then.type === "dont_ring")
      for (const e of matches.get(id)) silencedByAny.add(e);
  const silencedByOrdinary = new Set(silencedByAny);
  const firstOfDay = (id, r, silenced) => {
    const seen = new Set();
    matches.set(
      id,
      new Set(
        candidates(r)
          .filter((e) => {
            if (!ringsUsually(e) || (!e.personalChoice && silenced.has(e.id)))
              return false;
            if (seen.has(day(e))) return false;
            seen.add(day(e));
            return true;
          })
          .map((e) => e.id),
      ),
    );
  };
  for (const [id, r] of active)
    if (isFirstOfDay(r) && r.then.type === "dont_ring") {
      firstOfDay(id, r, silencedByOrdinary);
      for (const e of matches.get(id)) silencedByAny.add(e);
    }
  for (const [id, r] of active)
    if (isFirstOfDay(r) && r.then.type !== "dont_ring")
      firstOfDay(id, r, silencedByAny);
  return Object.fromEntries(
    ordered.map((e) => {
      // In rule order, which breaks ties between equal-priority rules below.
      const applicable =
        e.personalChoice || !e.eligible || e.duplicate
          ? []
          : active.filter(([id]) => matches.get(id)?.has(e.id));
      const silencedByRules = applicable
        .filter(([, r]) => r.then.type === "dont_ring")
        .map(([id]) => id);
      const rings = new Map(
        e.rings.map((r) => [r.minutes, { ...r, ruleIds: [] }]),
      );
      if (silencedByRules.length) rings.clear();
      else
        for (const [id, r] of applicable) {
          const a = r.then,
            old = rings.get(a.minutes);
          // Rule labels beat inherited (series, calendar, default) labels; the first rule in
          // rule order wins among rules. A personal choice never reaches here.
          const label = old?.ruleIds.length
            ? (old.label ?? a.label)
            : (a.label ?? old?.label);
          rings.set(a.minutes, {
            minutes: a.minutes,
            style:
              (old && (old.style ?? "alarm") === "alarm") || (a.style ?? "alarm") === "alarm"
                ? "alarm"
                : "notification",
            label: label ?? null,
            ruleIds: [...(old?.ruleIds ?? []), id],
          });
        }
      return [
        e.id,
        {
          rings: [
            ...rings.values(),
            // dont_ring silences travel rings too; a silent copy never rings its own.
            ...(silencedByRules.length || e.duplicate ? [] : (e.travelRings ?? [])),
          ].sort((a, b) => b.minutes - a.minutes),
          silencedByRules,
          eligible: !!e.eligible,
        },
      ];
    }),
  );
}
/**
 * Compares complete before/after outcomes. `events` are whole days; `shown` (a predicate), when
 * given, limits the listed changes and the count to those events (upcoming ones), while every
 * event still takes part in the evaluation.
 */
function preview(events, beforeRules, afterRules, zone, shown = null) {
  const before = evaluate(events, beforeRules, zone),
    after = evaluate(events, afterRules, zone);
  const outcome = (v) =>
    JSON.stringify(
      v.rings.map((r) => [
        r.kind ?? "lead",
        r.at ?? null,
        r.minutes,
        r.label ?? null,
        r.style ?? "alarm",
      ]),
    );
  const listed = (shown ? events.filter(shown) : events)
    .slice()
    .sort((a, b) => a.start - b.start || cmp(String(a.id), String(b.id)));
  const changes = listed
    .filter((e) => outcome(before[e.id]) !== outcome(after[e.id]))
    .map((e) => ({
      eventKey: e.eventKey !== undefined ? e.eventKey : e.id,
      title: e.title,
      start: e.start,
      before: before[e.id],
      after: after[e.id],
    }));
  const silencedCount = changes.filter(
    (c) => c.before.rings.length && !c.after.rings.length,
  ).length;
  return {
    changes,
    totalUpcoming: listed.length,
    changedCount: changes.length,
    silencedCount,
    largeShare: listed.length >= 10 && silencedCount * 2 > listed.length,
  };
}
module.exports = { evaluate, preview, sentence, understood, activeRules, MAX_RULES };

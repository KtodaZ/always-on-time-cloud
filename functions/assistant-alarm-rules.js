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
// Pure equivalent of AlarmRuleEvaluator. Events contain ordinary (pre-rule) rings.
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
  const ordered = [...events].sort(
    (a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)),
  );
  // Events that are the first to start after a matching event ends, on the same day and
  // within the gap. One pass per (text, hours) pair instead of rescanning per event.
  const nextAfterCache = new Map();
  const nextAfter = (c) => {
    const key = `${c.text}\u0000${c.hours ?? 2}`;
    if (nextAfterCache.has(key)) return nextAfterCache.get(key);
    const hits = new Set();
    ordered.forEach((p, i) => {
      if (!firstSkipMatch(p.title, [c.text])) return;
      for (let j = i + 1; j < ordered.length; j++) {
        const n = ordered[j];
        if (day(n) !== day(p)) break;
        if (n.start < p.end) continue;
        if (n.start - p.end <= (c.hours ?? 2) * 3600000) hits.add(n.id);
        break;
      }
    });
    nextAfterCache.set(key, hits);
    return hits;
  };
  const ordinary = (c, e) => {
    if (c.type === "title_contains") return !!firstSkipMatch(e.title, [c.text]);
    if (c.type === "on_calendar")
      return e.calendarKey != null && e.calendarKey === c.calendarKey;
    if (c.type === "first_of_day") return true;
    if (c.type === "next_after") return nextAfter(c).has(e.id);
    return false;
  };
  const matches = [];
  for (const [id, r] of Object.entries(rules).sort(
    ([a, x], [b, y]) => x.order - y.order || a.localeCompare(b),
  )) {
    try {
      validateRule(r);
    } catch {
      continue;
    }
    if (!r.enabled || !understood(r)) continue;
    let candidates = ordered.filter(
      (e) => e.eligible && r.when.every((c) => ordinary(c, e)),
    );
    if (r.when.some((c) => c.type === "first_of_day")) {
      const seen = new Set();
      candidates = candidates.filter((e) => {
        const d = day(e);
        if (e.allDay || !e.rings.length || seen.has(d)) return false;
        seen.add(d);
        return true;
      });
    }
    matches.push([id, r, new Set(candidates.map((e) => e.id))]);
  }
  return Object.fromEntries(
    ordered.map((e) => {
      const applicable =
        e.personalChoice || !e.eligible
          ? []
          : matches.filter(([, , ids]) => ids.has(e.id));
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
          const label = old?.ruleIds.length
            ? (old.label ?? a.label)
            : (a.label ?? old?.label);
          rings.set(a.minutes, {
            minutes: a.minutes,
            style:
              old?.style === "alarm" || (a.style ?? "alarm") === "alarm"
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
            ...(silencedByRules.length ? [] : (e.travelRings ?? [])),
          ].sort((a, b) => b.minutes - a.minutes),
          silencedByRules,
        },
      ];
    }),
  );
}
function preview(events, beforeRules, afterRules, zone) {
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
  const changes = events
    .filter((e) => outcome(before[e.id]) !== outcome(after[e.id]))
    .map((e) => ({
      eventKey: e.id,
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
    totalUpcoming: events.length,
    changedCount: changes.length,
    silencedCount,
    largeShare: events.length >= 10 && silencedCount * 2 > events.length,
  };
}
module.exports = { evaluate, preview, sentence, understood };

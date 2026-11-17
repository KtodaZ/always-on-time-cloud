"use strict";
const z = require("zod");
const { randomUUID } = require("node:crypto");
const { refs, readValues, toMillis } = require("./assistant-data");
const {
  encodePayload,
  samePayload,
  sha256Hex,
  validateRule,
  firstSkipMatch,
  decodeSkipKeywords,
} = require("./assistant-records");
const { parseStored } = require("./assistant-settings");
const {
  latestSnapshot,
  applyChange,
  result,
  noPhone,
} = require("./assistant-tool-context");
const {
  ToolError,
  cleanText,
  quoted,
  isoLocal,
} = require("./assistant-snapshot");
const {
  preview,
  sentence,
  understood,
  phoneOnly,
} = require("./assistant-alarm-rules");
// The conditions only the phone can check; the snapshot never has links, locations or guests.
const PHONE_ONLY_NOTE =
  "This rule checks meeting links, locations or guest counts, which the assistant never sees, so it can't list the events it affects. Always On Time on the phone will show which events match once the rule is on (Alarm rules, then this rule). Tell the user that, and that applying works as usual.";
// Fields each condition type takes, for rejecting stray ones in assistant-made rules.
const CONDITION_FIELDS = {
  first_of_day: [],
  title_contains: ["text"],
  on_calendar: ["calendarKey"],
  next_after: ["text", "hours"],
  time_of_day: ["compare", "minute"],
  day_of_week: ["days"],
  video_link: ["has"],
  location: ["has"],
  attendees: ["compare", "count"],
};
/** Assistant input: at most one condition per type, only that type's fields, days sorted. */
function tidyConditions(when) {
  const seen = new Set();
  return when.map((c) => {
    if (seen.has(c.type))
      throw new ToolError(`Use each condition type at most once (${c.type}).`);
    seen.add(c.type);
    for (const field of Object.keys(c))
      if (field !== "type" && !CONDITION_FIELDS[c.type].includes(field))
        throw new ToolError(`${c.type} does not take ${field}.`);
    return c.days ? { ...c, days: [...new Set(c.days)].sort((a, b) => a - b) } : c;
  });
}
const RULE_ID = /^r_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const previews = (ctx) =>
  refs.account(ctx.db, ctx.uid).collection("assistantRulePreviews");
async function rulesOf(ctx, read = (query) => query.get()) {
  const docs = await read(
    refs
      .values(ctx.db, ctx.uid)
      .orderBy("__name__")
      .startAt("r_")
      .endBefore("s_")
      .limit(100),
  );
  const rules = {};
  for (const doc of docs.docs)
    if (RULE_ID.test(doc.id)) {
      const v = parseStored(doc.data().payload);
      if (v) {
        try {
          validateRule(v);
          rules[doc.id] = v;
        } catch {
          throw new ToolError(
            "A synced rule is invalid. Open Alarm rules in the app before changing rules here.",
          );
        }
      }
    }
  if (Object.keys(rules).length > 30)
    throw new ToolError(
      "There are more than 30 rules. Remove rules in the app first.",
    );
  return rules;
}
// Builds the evaluator's inputs (assistant-alarm-rules.js) from the latest snapshot and the synced
// values, mirroring the phones' AlarmRuleInputs as far as the snapshot allows:
// - Whole days: the snapshot holds events that end after it was built (in-progress ones
//   included) up to its window end, so events that already ended earlier today are missing and
//   "first of the day" / "next after" can't see them for the current day.
// - Cancelled, deleted and superseded occurrences never reach the snapshot; RSVP- and
//   all-day-filtered ones are dropped here too (re-checked against synced settings), so none of
//   them is a candidate or a next_after predecessor.
// - Silent duplicate copies aren't flagged in the snapshot, and it has no locations: copies are
//   inferred as non-all-day events with the same title (ignoring case and spacing) and start,
//   keeping the copy with a ring on, then a personal choice, then the lowest key. Two same-named
//   events at different places would wrongly be treated as copies.
// - Ring options come from the tier that owns the lead-time list (event > series > calendar >
//   app default). The snapshot's calendar lead times are effective values, so a calendar counts
//   as owning them only when its record sets them or they differ from the app default.
function eventsOf(snapshot, values) {
  // Lists and option maps are JSON inside the stored string; plain strings stay as they are.
  const json = (v) =>
    typeof v === "string" && /^\s*[[{]/.test(v) ? parseStored(v) : v;
  const value = (id) => (id ? json(parseStored(values[id])) : null);
  const same = (a, b) =>
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    [...a].sort((x, y) => x - y).every((m, i) => m === [...b].sort((x, y) => x - y)[i]);
  const defaults = value("p_default_lead_times_csv") ?? [
    value("p_default_lead_time_minutes") ?? 10,
  ];
  const defaultOptions = value("p_default_ring_options") ?? {};
  const keywords = decodeSkipKeywords(parseStored(values.p_skip_event_keywords));
  const built = snapshot.events.flatMap((e, index) => {
    const cal = snapshot.calendars.find((c) => c.key === e.calendarKey);
    const record = (e.calendarKey && value(e.calendarKey)) || {};
    const c = record.overrides ?? {};
    const s = (e.seriesKey && value(e.seriesKey)) || {},
      own = (e.eventKey && value(e.eventKey)) || {};
    const layers = [own, s, c];
    const rsvp =
      layers.find((v) => v.rsvpFilter != null)?.rsvpFilter ??
      cal?.rsvpFilter ??
      value("p_rsvp_filter") ??
      "not_declined";
    const rsvpOk =
      rsvp === "all_events" ||
      e.rsvp == null ||
      e.rsvp === "NONE" ||
      e.rsvp === "ORGANIZER" ||
      (rsvp === "accepted_only"
        ? e.rsvp === "ACCEPTED"
        : rsvp === "accepted_or_tentative"
          ? ["ACCEPTED", "TENTATIVE"].includes(e.rsvp)
          : e.rsvp !== "DECLINED");
    const allDayIgnored =
      e.allDay &&
      (c.ignoreAllDay ??
        (cal?.includeAllDay == null
          ? (value("p_ignore_all_day_events") ?? true)
          : !cal.includeAllDay));
    // Filtered occurrences aren't in the phones' event set at all.
    if (!rsvpOk || allDayIgnored) return [];
    const ownsLeads = (v) => v.leadTimes != null;
    const personalChoice =
      [own, s].some((v) => ownsLeads(v) || v.enabled != null) ||
      e.alarms.some((a) => ["event", "series"].includes(a.source));
    // The event's own switch: its own choice, its series, then its calendar.
    const enabled =
      layers.find((v) => v.enabled != null)?.enabled ?? cal?.enabled ?? true;
    const calendarLeads =
      c.leadTimes ??
      (cal?.leadTimes != null && !same(cal.leadTimes, defaults)
        ? cal.leadTimes
        : null);
    const usual =
      s.leadTimes != null
        ? { minutes: s.leadTimes, options: s.ringOptions ?? {} }
        : calendarLeads != null
          ? { minutes: calendarLeads, options: c.ringOptions ?? {} }
          : { minutes: defaults, options: defaultOptions };
    const snapshotOwn = e.alarms.filter(
      (a) =>
        a.kind === "lead" &&
        a.source !== "rule" &&
        ["event", "series"].includes(a.source),
    );
    // A personal occurrence keeps its own rings (its own options, else the usual tier's); one
    // known only from the snapshot keeps the rings and options the phone reported.
    const rings =
      own.leadTimes != null
        ? own.leadTimes.map((minutes) => ({
            minutes,
            ...((own.ringOptions ?? usual.options)[String(minutes)] ?? {}),
          }))
        : s.leadTimes == null && snapshotOwn.length && personalChoice
          ? snapshotOwn
          : usual.minutes.map((minutes) => ({
              minutes,
              ...(usual.options[String(minutes)] ?? {}),
            }));
    const skip = firstSkipMatch(e.title, keywords);
    const eligible =
      enabled &&
      cal?.watched !== false &&
      record.selected !== false &&
      (!skip || !!own.keywordExempt || !!s.keywordExempt);
    // Minutes turned off one by one. The snapshot's "off" also covers a switched-off event, rule
    // silence, keyword skips and travel-covered defaults, so it is read only when none applies.
    const ordinaryOff =
      eligible &&
      !e.skippedByKeyword &&
      !e.silencedByRules?.length &&
      !e.alarms.some((a) => a.kind === "travel")
        ? e.alarms
            .filter((a) => a.kind === "lead" && a.source !== "rule" && a.status === "off")
            .map((a) => a.minutes)
        : [];
    const ringOn = e.alarms.some(
      (a) => a.kind === "lead" && a.status !== "off",
    );
    return [
      {
        ...e,
        id: e.eventKey ?? `#${index}`,
        eventKey: e.eventKey ?? null,
        end: Number.isFinite(e.end) ? e.end : e.start,
        personalChoice,
        eligible,
        ringOn,
        offMinutes: ordinaryOff,
        travelRings: eligible
          ? e.alarms.filter((a) => a.kind === "travel" && a.status !== "off")
          : [],
        rings: eligible
          ? [...new Map(rings.map((a) => [a.minutes, a])).values()].map((a) => ({
              minutes: a.minutes,
              label: a.label ?? null,
              style: a.style ?? "alarm",
            }))
          : [],
      },
    ];
  });
  const copies = new Map();
  for (const e of built) {
    const title = e.title.trim().replace(/\s+/g, " ").toLowerCase();
    if (e.allDay || !title) continue;
    const key = `${title}\u0000${e.start}`;
    if (!copies.has(key)) copies.set(key, []);
    copies.get(key).push(e);
  }
  for (const group of copies.values())
    if (group.length > 1)
      group
        .sort(
          (a, b) =>
            Number(b.ringOn) - Number(a.ringOn) ||
            Number(b.personalChoice) - Number(a.personalChoice) ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
        .slice(1)
        .forEach((e) => (e.duplicate = true));
  return built.map(({ ringOn, ...e }) => e);
}
const digest = (data) =>
  sha256Hex(
    JSON.stringify([
      data.ruleId,
      data.payload,
      data.operation,
      data.baseline,
      data.grantId,
      data.snapshotAt,
    ]),
  );
const TOOLS = [
  {
    name: "list_rules",
    title: "List alarm rules",
    description:
      "Alarm rules with their sentence, on/off state and creator. A rule has one to four conditions that must all hold: first_of_day, title_contains, on_calendar, next_after, time_of_day, day_of_week, video_link, location, attendees.",
    scope: "read",
    annotations: READ,
    inputSchema: {},
    async handler(ctx) {
      const [rules, snapshot] = await Promise.all([
        rulesOf(ctx),
        latestSnapshot(ctx),
      ]);
      const list = Object.entries(rules)
        .sort(([, a], [, b]) => a.order - b.order)
        .map(([ruleId, r]) => ({
          ruleId,
          sentence: sentence(r, snapshot?.calendars),
          enabled: r.enabled,
          createdBy: r.createdBy,
          assistantName: r.assistantName ?? null,
        }));
      return result(
        list.length
          ? list
              .map(
                (r) =>
                  `${r.enabled ? "On" : "Off"}: ${quoted(r.sentence)} · ${r.assistantName ?? r.createdBy} (${r.ruleId})`,
              )
              .join("\n")
          : "No alarm rules yet.",
        { rules: list },
      );
    },
  },
  {
    name: "preview_rule",
    title: "Preview an alarm rule",
    description:
      "Preview creating, editing, deleting, enabling or disabling a rule. Show this preview and obtain the user’s yes in chat before apply_rule. Never writes a rule. A rule has 1–4 conditions that must all hold, at most one of each type: first_of_day; title_contains (text); on_calendar (calendarKey); next_after (text, hours 1–6); time_of_day (compare before|after, minute 0–1439 after midnight, local); day_of_week (days: 1 Monday to 7 Sunday, 1–6 of them); video_link (has true|false); location (has true|false); attendees (compare at_least|at_most, count 1–99 including the user; at_least 1 is not allowed). video_link, location and attendees can't be checked from the phone snapshot: the preview then lists no events (previewMode phone_only) and says the phone will show the matching events; tell the user, and apply_rule works as usual.",
    scope: "write",
    annotations: { ...READ, readOnlyHint: false },
    inputSchema: {
      operation: z.enum(["create", "edit", "delete", "enable", "disable"]),
      ruleId: z.string().regex(RULE_ID).optional(),
      rule: z
        .object({
          enabled: z.boolean().optional(),
          order: z.number().int().optional(),
          when: z
            .array(
              z
                .object({
                  type: z.enum([
                    "first_of_day",
                    "title_contains",
                    "on_calendar",
                    "next_after",
                    "time_of_day",
                    "day_of_week",
                    "video_link",
                    "location",
                    "attendees",
                  ]),
                  text: z.string().optional(),
                  calendarKey: z.string().optional(),
                  hours: z.number().int().optional(),
                  compare: z
                    .enum(["before", "after", "at_least", "at_most"])
                    .optional(),
                  minute: z.number().int().min(0).max(1439).optional(),
                  days: z
                    .array(z.number().int().min(1).max(7))
                    .min(1)
                    .max(6)
                    .optional(),
                  has: z.boolean().optional(),
                  count: z.number().int().min(1).max(99).optional(),
                })
                .strict(),
            )
            .min(1)
            .max(4),
          then: z
            .object({
              type: z.enum(["add_ring", "dont_ring"]),
              minutes: z.number().int().optional(),
              label: z.string().max(40).optional(),
              style: z.enum(["alarm", "notification"]).optional(),
            })
            .strict(),
        })
        .strict()
        .optional(),
    },
    async handler(ctx, args) {
      const snapshot = await latestSnapshot(ctx);
      if (!snapshot) return noPhone(ctx);
      const rules = await rulesOf(ctx);
      const ruleId =
        args.operation === "create" ? `r_${randomUUID()}` : args.ruleId;
      if (!ruleId || (args.operation !== "create" && !rules[ruleId]))
        throw new ToolError("Choose an existing ruleId from list_rules.");
      if (args.operation === "create" && Object.keys(rules).length >= 30)
        throw new ToolError("At most 30 rules are allowed.");
      if (["create", "edit"].includes(args.operation) !== !!args.rule)
        throw new ToolError("Supply rule only for create or edit.");
      if (args.rule) args.rule = { ...args.rule, when: tidyConditions(args.rule.when) };
      let rule =
        args.operation === "delete"
          ? null
          : ["enable", "disable"].includes(args.operation)
            ? { ...rules[ruleId], enabled: args.operation === "enable" }
            : {
                ...rules[ruleId],
                ...args.rule,
                enabled: args.rule.enabled ?? rules[ruleId]?.enabled ?? true,
                order:
                  args.rule.order ??
                  rules[ruleId]?.order ??
                  Object.keys(rules).length,
                createdBy: "assistant",
                createdAt: rules[ruleId]?.createdAt ?? ctx.now(),
                assistantName:
                  cleanText(ctx.grant.clientName, 100) || "Assistant",
              };
      if (rule) {
        validateRule(rule);
        if (!understood(rule))
          throw new ToolError(
            "This rule uses unsupported vocabulary. Edit it in the app.",
          );
      }
      if (
        samePayload(
          ruleId,
          encodePayload(ruleId, rules[ruleId] ?? null),
          encodePayload(ruleId, rule),
        )
      )
        throw new ToolError(
          "That rule is already set that way. Nothing to apply.",
        );
      const after = { ...rules };
      if (rule) after[ruleId] = rule;
      else delete after[ruleId];
      const ids = [
        ...Object.keys(rules),
        ruleId,
        ...snapshot.events.flatMap((e) => [
          e.eventKey,
          e.seriesKey,
          e.calendarKey,
        ]),
        "p_default_lead_times_csv",
        "p_default_lead_time_minutes",
        "p_default_ring_options",
        "p_skip_event_keywords",
        "p_rsvp_filter",
        "p_ignore_all_day_events",
      ].filter(Boolean);
      const baseline = await readValues(ctx.db, ctx.uid, [...new Set(ids)]);
      if (
        Object.entries(rules).some(
          ([id, r]) => !samePayload(id, baseline[id], encodePayload(id, r)),
        ) ||
        (args.operation === "create" && baseline[ruleId] !== null)
      )
        throw new ToolError(
          "Rules changed while previewing. Call preview_rule again.",
        );
      // The phone alone can check links, locations and guest counts, so a rule using them (before
      // or after the change) is validated and applied as usual but its events aren't listed.
      const phoneOnlyPreview = phoneOnly(rules[ruleId]) || phoneOnly(rule);
      const ignored = Object.entries(after)
        .filter(([, r]) => r.enabled && phoneOnly(r))
        .map(([id]) => id);
      const text = sentence(rule ?? rules[ruleId], snapshot.calendars);
      let out;
      if (phoneOnlyPreview) {
        out = {
          previewMode: "phone_only",
          phoneOnlyNote: PHONE_ONLY_NOTE,
          changes: null,
          changedCount: null,
          totalUpcoming: null,
          silencedEvents: null,
          silencedCount: 0,
          largeShare: null,
        };
      } else {
        // Whole days are evaluated; only upcoming events are listed and counted. Other enabled
        // rules that use phone-only conditions take no part, so the preview is approximate.
        out = preview(
          eventsOf(snapshot, baseline),
          rules,
          after,
          snapshot.timeZone,
          (e) => e.start > ctx.now(),
        );
        out.previewMode = "events";
        out.silencedEvents = out.changes.filter(
          (c) => c.before.rings.length && !c.after.rings.length,
        );
        out.silencedCount = out.silencedEvents.length;
        out.largeShare =
          out.totalUpcoming >= 10 && out.silencedCount * 2 > out.totalUpcoming;
        for (const c of out.changes)
          for (const side of ["before", "after"])
            c[side].ringTimes = c[side].rings.map((r) =>
              isoLocal(
                r.kind === "travel" ? r.at : c.start - r.minutes * 60000,
                snapshot.timeZone,
              ),
            );
      }
      const previewId = `pr_${randomUUID()}`;
      const data = {
        ruleId,
        payload: encodePayload(ruleId, rule),
        operation: args.operation,
        baseline,
        grantId: ctx.grant.grantId,
        snapshotAt: snapshot.publishedAt,
      };
      await previews(ctx)
        .doc(previewId)
        .create({
          ...data,
          digest: digest(data),
          expiresAt: new Date(ctx.now() + 15 * 60000),
          sentence: text,
          silencedCount: out.silencedCount,
        });
      const ignoredNote =
        !phoneOnlyPreview && ignored.length
          ? " Other rules that check links, locations or guest counts aren't included here."
          : "";
      return result(
        phoneOnlyPreview
          ? `${args.operation}: ${quoted(text)}. ${PHONE_ONLY_NOTE} Show the sentence and get the user’s yes in chat before apply_rule.`
          : `${args.operation}: ${quoted(text)}. Changes ${out.changedCount} upcoming events; silences ${out.silencedCount}.${out.largeShare ? " This silences more than half of at least 10 upcoming events." : ""}\n${out.changes.map((c) => `${quoted(c.title)}: ${c.before.ringTimes.join(" · ") || "no rings"} → ${c.after.ringTimes.join(" · ") || "silenced"}`).join("\n")}\nPreview uses the latest snapshot; local-only choices, merged rule rings and silenced travel timing may be incomplete.${ignoredNote} Show this preview and get the user’s yes in chat before apply_rule.`,
        {
          previewId,
          ruleId,
          sentence: text,
          ...out,
          basedOn: {
            device: snapshot.device,
            publishedAt: snapshot.publishedAt,
          },
          limitations: phoneOnlyPreview
            ? "No event list: the phone shows which events match. The assistant never sees meeting links, locations or guest counts."
            : `Approximate preview: based on the latest phone snapshot and synced settings. Local-only choices and travel timing are not fully reconstructible; the phone evaluates the final schedule.${ignoredNote}`,
        },
      );
    },
  },
  {
    name: "apply_rule",
    title: "Apply a previewed alarm rule",
    description:
      "Apply exactly one preview after showing it and receiving the user’s yes in chat. No second in-app approval. Previews expire after 15 minutes and can only be used once.",
    scope: "write",
    annotations: WRITE,
    inputSchema: { previewId: z.string().regex(/^pr_[a-f0-9-]{36}$/) },
    async handler(ctx, args) {
      const ref = previews(ctx).doc(args.previewId);
      let approved;
      const check = (doc) => {
        const p = doc.data();
        if (
          !doc.exists ||
          p.usedAt ||
          toMillis(p.expiresAt) <= ctx.now() ||
          p.grantId !== ctx.grant.grantId ||
          p.digest !== digest(p)
        )
          throw new ToolError(
            "Preview missing, expired, mismatched or already used. Call preview_rule again.",
          );
        return p;
      };
      approved = check(await ref.get());
      const verb = {
        create: "added",
        edit: "edited",
        delete: "deleted",
        enable: "enabled",
        disable: "disabled",
      }[approved.operation];
      const summary = `${cleanText(ctx.grant.clientName, 100) || "Assistant"} ${verb} a rule: ${approved.sentence}${approved.silencedCount > 0 ? ` · ${approved.silencedCount} ${approved.silencedCount === 1 ? "event" : "events"}` : ""}`;
      const rule = parseStored(approved.payload);
      // A rule using phone-only conditions has no silenced count; it still alerts when it
      // switches on a don't-ring.
      const alert =
        approved.silencedCount > 0 ||
        (approved.operation === "create" && rule?.then.type === "dont_ring") ||
        (phoneOnly(rule) && rule.enabled && rule.then.type === "dont_ring")
          ? "alarms_off"
          : null;
      return applyChange(ctx, {
        tool: "apply_rule",
        atomicReads: true,
        summary,
        alert: () => alert,
        ruleAlert: alert
          ? {
              text: summary,
              sentence: approved.sentence,
              operation: approved.operation,
              affectedCount: approved.silencedCount,
            }
          : null,
        recordIds: Object.keys(approved.baseline),
        build: async (current, read) => {
          const p = check(await read(ref));
          if (
            Object.keys(p.baseline).some(
              (id) => !samePayload(id, current[id], p.baseline[id]),
            )
          )
            throw new ToolError(
              "Settings changed since this preview. Call preview_rule again.",
            );
          const rules = await rulesOf(ctx, read);
          // A newer phone snapshot alone (any scheduling pass publishes one) doesn't
          // invalidate the preview; changed settings or rules do (checked above and here).
          if (Object.keys(rules).some((id) => !(id in p.baseline)))
            throw new ToolError(
              "Rules changed since this preview. Call preview_rule again.",
            );
          if (p.operation === "create" && Object.keys(rules).length >= 30)
            throw new ToolError("At most 30 rules are allowed.");
          return { [p.ruleId]: parseStored(p.payload) };
        },
        afterWrite: (batch, snapshotOf) =>
          batch.update(
            ref,
            { usedAt: new Date(ctx.now()) },
            { lastUpdateTime: snapshotOf(ref).updateTime },
          ),
      });
    },
  },
];
for (const tool of TOOLS) {
  const handler = tool.handler;
  tool.handler = async (ctx, args) => {
    try {
      return await handler(ctx, args);
    } catch (error) {
      if (error instanceof require("./assistant-records").RecordError)
        throw new ToolError(error.message);
      throw error;
    }
  };
}
module.exports = { TOOLS, eventsOf };

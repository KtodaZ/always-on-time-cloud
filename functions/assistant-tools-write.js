"use strict";

// Write tools: each plans a change to account sync records, and writeTool saves it through
// applyChange (validated, canonical, logged for undo with an alert when alarms could go quiet,
// then announced to the phones).

const z = require("zod");

const {
  CHANGE_ID_PATTERN, DAY_MS, UNDO_DAYS, readDevices, readValues, refs,
} = require("./assistant-data");
const {
  PAUSED_UNTIL, RecordError, isRecordId, samePayload, validatePayload,
} = require("./assistant-records");
const {
  RSVP_FILTER_VALUES, SETTINGS, leadTimesInput, leadTimesText, parseStored, tidyLeadTimes,
} = require("./assistant-settings");
const {
  ToolError, formatTime, parseTime, quoted, resolveCalendar, resolveEvent,
} = require("./assistant-snapshot");
const {
  accountEmails, applyChange, hasCapability, latestSnapshot, noPhone, trace,
} = require("./assistant-tool-context");
const { eventInputs } = require("./assistant-tools-read");

const MAX_PAUSE_DAYS = 366;
const RESPECT_DND = "p_respect_dnd";

// Hints for clients (MCP tool annotations): any of these can stop alarms from ringing, so clients
// that confirm destructive actions ask first. resume_alarms only turns alarms back on.
const MAY_SILENCE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const RESTORES = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const changeIdInput = (description) => z.string().regex(CHANGE_ID_PATTERN).describe(description);

/**
 * A write tool: `plan(ctx, args)` resolves what to change and returns applyChange's options
 * ({recordIds, build, summary, afterWrite}) plus an optional `finish(out)` to add to the result,
 * or {result} to answer without changing anything.
 */
function writeTool({ plan, ...tool }) {
  return {
    scope: "write",
    annotations: MAY_SILENCE,
    ...tool,
    async handler(ctx, args) {
      const { result, finish, ...change } = await plan(ctx, args);
      if (result) return result;
      const out = await applyChange(ctx, { tool: tool.name, ...change });
      if (finish) finish(out);
      return out;
    },
  };
}

const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

/** Builds an Override for set/off/reset from the stored one, keeping fields the assistant doesn't manage. */
function nextOverride(stored, mode, leadTimes, currentLeadTimes) {
  if (mode === "reset") return null;
  const base = { ...asObject(stored) };
  if (mode === "off") {
    return { ...base, leadTimes: base.leadTimes ?? currentLeadTimes ?? [], enabled: false };
  }
  const next = { ...base, leadTimes, enabled: true };
  const added = (Array.isArray(base.addedLeadTimes) ? base.addedLeadTimes : []).filter((minutes) => leadTimes.includes(minutes));
  if (added.length) next.addedLeadTimes = added;
  else delete next.addedLeadTimes;
  return next;
}

function modeOf(args) {
  const mode = args.mode ?? "set";
  if (mode === "set" && !args.leadTimes) throw new ToolError("Give leadTimes to set, or use mode \"off\" or \"reset\".");
  if (mode !== "set" && args.leadTimes) throw new ToolError(`leadTimes only apply with mode "set".`);
  return mode;
}

const currentLeadMinutes = (event) => (event ? tidyLeadTimes(event.alarms.filter((alarm) => alarm.kind === "lead").map((alarm) => alarm.minutes)) : null);

const modeInput = (reset) => z.enum(["set", "off", "reset"]).optional()
  .describe(`set (default; needs leadTimes), off (no alarms), or reset (follow the ${reset} settings again).`);

const TOOLS = [
  writeTool({
    name: "set_event_alarms",
    title: "Set alarms for one event",
    description: "Changes the alarms for one event occurrence only: set lead times, turn its alarms off, or reset it to follow its series, calendar and app settings. For every occurrence of a recurring event use set_series_alarms. Returns a changeId; then call confirm_change.",
    inputSchema: { ...eventInputs, mode: modeInput("series/calendar/app"), leadTimes: leadTimesInput.optional() },
    async plan(ctx, args) {
      const mode = modeOf(args);
      const snapshot = await latestSnapshot(ctx);
      const resolved = resolveEvent(snapshot, args, { accountEmails: await accountEmails(ctx) });
      const event = resolved.event;
      if (event && event.start <= ctx.now()) throw new ToolError("That event has already started, so its alarms can't change.");
      const leadTimes = args.leadTimes ? tidyLeadTimes(args.leadTimes) : null;
      const label = event ? `${quoted(event.title)} (${formatTime(event.start, snapshot.timeZone)})` : "that event";
      return {
        recordIds: [resolved.eventKey],
        summary: mode === "set" ? `Set ${label} to ring ${leadTimesText(leadTimes)}`
          : mode === "off" ? `Turned off alarms for ${label}` : `Reset ${label} to follow its usual settings`,
        build: (current) => ({
          [resolved.eventKey]: nextOverride(parseStored(current[resolved.eventKey]), mode, leadTimes, currentLeadMinutes(event)),
        }),
        finish: (out) => {
          if (!event) out.text += " That event isn't in what the phone shared yet, so it applies once the phone sees it.";
          out.data.eventKey = resolved.eventKey;
        },
      };
    },
  }),
  writeTool({
    name: "set_series_alarms",
    title: "Set alarms for a recurring series",
    description: "Changes the alarms for every occurrence of a recurring event: set lead times, turn them off, or reset to follow the calendar and app settings. Occurrences with their own setting keep it. Name the series by any of its event keys, its series key, or Google ids. Returns a changeId; then call confirm_change.",
    inputSchema: {
      ...eventInputs,
      event: z.string().max(80).optional().describe("Any event key (e_...) of the series, or its series key (s_...)."),
      mode: modeInput("calendar/app"),
      leadTimes: leadTimesInput.optional(),
    },
    async plan(ctx, args) {
      const mode = modeOf(args);
      const snapshot = await latestSnapshot(ctx);
      const resolved = resolveEvent(snapshot, args, { accountEmails: await accountEmails(ctx), needOccurrence: false });
      if (!resolved.seriesKey) throw new ToolError("That event isn't in what the phone shared, so its series is unknown. Use find_events, or Google Calendar ids from the calendar connector.");
      if (resolved.recurring === false || (resolved.event && !resolved.event.recurring)) {
        throw new ToolError("That event doesn't repeat; use set_event_alarms for it.");
      }
      const sample = resolved.event ?? snapshot?.events.find((item) => item.seriesKey === resolved.seriesKey) ?? null;
      const leadTimes = args.leadTimes ? tidyLeadTimes(args.leadTimes) : null;
      const label = sample ? `every ${quoted(sample.title)}` : "that recurring event";
      return {
        recordIds: [resolved.seriesKey],
        summary: mode === "set" ? `Set ${label} to ring ${leadTimesText(leadTimes)}`
          : mode === "off" ? `Turned off alarms for ${label}` : `Reset ${label} to follow its calendar's settings`,
        build: (current) => ({
          [resolved.seriesKey]: nextOverride(parseStored(current[resolved.seriesKey]), mode, leadTimes, currentLeadMinutes(sample)),
        }),
        finish: (out) => {
          out.data.seriesKey = resolved.seriesKey;
        },
      };
    },
  }),
  writeTool({
    name: "set_calendar",
    title: "Change a calendar's alarms",
    description: "Changes one calendar on the phone: whether the app watches it (rings for its events), its default lead times, which invitations ring, and whether its alarms ring through Do Not Disturb (for important calendars when update_settings respectDoNotDisturb is on; otherwise alarms already ring whenever the system allows). All-day events are an app-wide setting (update_settings ignoreAllDayEvents). Local-only calendars can't be changed here. Returns a changeId; then call confirm_change.",
    inputSchema: {
      calendar: z.string().min(1).max(300).describe("Calendar key, name, or Google calendarId."),
      watched: z.boolean().optional().describe("true to ring for this calendar's events, false to stop."),
      leadTimes: leadTimesInput.optional(),
      useAppDefaultLeadTimes: z.boolean().optional().describe("true to drop the calendar's own lead times and use the app default."),
      rsvpFilter: z.enum(RSVP_FILTER_VALUES).optional().describe("Which invitations ring."),
      ringThroughDoNotDisturb: z.boolean().optional()
        .describe("true for this calendar's alarms to ring with sound during Do Not Disturb while Respect Do Not Disturb is on; false to keep them silent then. Android only."),
    },
    async plan(ctx, args) {
      const { watched, leadTimes, useAppDefaultLeadTimes, rsvpFilter, ringThroughDoNotDisturb } = args;
      if ([watched, leadTimes, useAppDefaultLeadTimes, rsvpFilter, ringThroughDoNotDisturb].every((value) => value === undefined)) {
        throw new ToolError("Say what to change: watched, leadTimes, useAppDefaultLeadTimes, rsvpFilter or ringThroughDoNotDisturb.");
      }
      if (leadTimes && useAppDefaultLeadTimes) throw new ToolError("Use either leadTimes or useAppDefaultLeadTimes, not both.");
      const snapshot = await latestSnapshot(ctx);
      const { calendar, key } = resolveCalendar(snapshot, args.calendar, { accountEmails: await accountEmails(ctx) });
      const name = calendar?.name ? quoted(calendar.name) : "that calendar";
      const parts = [];
      if (watched !== undefined) parts.push(watched ? "watched" : "not watched");
      if (leadTimes) parts.push(`ringing ${leadTimesText(tidyLeadTimes(leadTimes))}`);
      if (useAppDefaultLeadTimes) parts.push("using the app's default lead times");
      if (rsvpFilter) parts.push(`invitations: ${rsvpFilter.replace(/_/g, " ")}`);
      if (ringThroughDoNotDisturb === true) {
        const respectDnd = parseStored((await readValues(ctx.db, ctx.uid, [RESPECT_DND]))[RESPECT_DND]) === true;
        parts.push(respectDnd ? "rings through Do Not Disturb"
          : "rings through Do Not Disturb once Respect Do Not Disturb is on (it is off, so alarms already ring when the system allows)");
      }
      if (ringThroughDoNotDisturb === false) parts.push("silent during Do Not Disturb while Respect Do Not Disturb is on");
      return {
        recordIds: [key],
        summary: `Set ${name}: ${parts.join(", ")}`,
        build: (current) => {
          // Fields this server doesn't know (from a newer app) stay as they are.
          const stored = asObject(parseStored(current[key]));
          const overrides = { ...asObject(stored.overrides) };
          if (leadTimes) overrides.leadTimes = leadTimes;
          if (useAppDefaultLeadTimes) delete overrides.leadTimes;
          if (rsvpFilter) overrides.rsvpFilter = rsvpFilter;
          // Only true is stored; off is no override, as the app writes it.
          if (ringThroughDoNotDisturb === true) overrides.ringThroughDnd = true;
          if (ringThroughDoNotDisturb === false) delete overrides.ringThroughDnd;
          const meaningful = Object.values(overrides).some((value) => value !== null && value !== undefined);
          return { [key]: { ...stored, selected: watched ?? stored.selected ?? null, overrides: meaningful ? overrides : null } };
        },
      };
    },
  }),
  writeTool({
    name: "update_settings",
    title: "Change app settings",
    description: "Changes app-wide alarm, snooze, spoken-alarm and appearance settings. Only include the settings to change; null resets one to the app default. Pausing alarms has its own tools. Returns a changeId; then call confirm_change.",
    inputSchema: {
      settings: z.object(Object.fromEntries(Object.entries(SETTINGS).map(([field, setting]) => [field, setting.schema.nullable().optional()])))
        .strict().describe("Settings to change."),
    },
    async plan(ctx, args) {
      const entries = Object.entries(args.settings ?? {}).filter(([, value]) => value !== undefined);
      if (!entries.length) throw new ToolError("Include at least one setting to change.");
      const next = {};
      const parts = [];
      for (const [field, value] of entries) {
        const setting = SETTINGS[field];
        next[`p_${setting.record}`] = value === null ? null : setting.encode ? setting.encode(value) : value;
        parts.push(`${setting.label.replace(/ \(.*\)$/, "").toLowerCase()} ${value === null ? "reset to default" : Array.isArray(value) ? leadTimesText(tidyLeadTimes(value)) : value}`);
      }
      // Turning vibration off silences vibrate-only alarms, so the alert type is read alongside.
      const recordIds = Object.keys(next);
      if (next.p_vibration_enabled === false && !recordIds.includes("p_alert_type")) recordIds.push("p_alert_type");
      return { recordIds, summary: `Changed settings: ${parts.join(", ")}`, build: () => next };
    },
  }),
  writeTool({
    name: "pause_alarms",
    title: "Pause alarms",
    description: "Pauses every Always On Time alarm on the user's phones until a time, or until resumed. Returns a changeId; then call confirm_change.",
    inputSchema: {
      until: z.string().max(40).optional().describe("When alarms start ringing again, ISO 8601 (phone's time zone if no offset). Omit with indefinitely=true."),
      indefinitely: z.boolean().optional().describe("true to pause until the user resumes."),
    },
    async plan(ctx, args) {
      const devices = await readDevices(ctx.db, ctx.uid);
      if (!devices.length) return { result: noPhone(ctx) };
      if (!hasCapability(devices, "pause")) {
        throw new ToolError("The app on the user's phone can't be paused remotely yet. They can update Always On Time, or pause it in the app.");
      }
      const snapshot = await latestSnapshot(ctx);
      const timeZone = snapshot?.timeZone ?? "UTC";
      let until;
      if (args.indefinitely) {
        if (args.until) throw new ToolError("Use either until or indefinitely.");
        until = -1;
      } else {
        if (!args.until) throw new ToolError("Give until, or indefinitely=true.");
        until = parseTime(args.until, timeZone, "until");
        if (until <= ctx.now()) throw new ToolError("until must be in the future.");
        if (until - ctx.now() > MAX_PAUSE_DAYS * DAY_MS) throw new ToolError("Alarms can be paused for at most a year; use indefinitely instead.");
      }
      return {
        recordIds: [`p_${PAUSED_UNTIL}`],
        summary: until === -1 ? "Paused alarms until resumed" : `Paused alarms until ${formatTime(until, timeZone)}`,
        build: () => ({ [`p_${PAUSED_UNTIL}`]: until }),
      };
    },
  }),
  writeTool({
    name: "resume_alarms",
    title: "Resume alarms",
    description: "Ends a pause so alarms ring again. Returns a changeId; then call confirm_change.",
    inputSchema: {},
    annotations: RESTORES,
    async plan() {
      return { recordIds: [`p_${PAUSED_UNTIL}`], summary: "Resumed alarms", build: () => ({ [`p_${PAUSED_UNTIL}`]: 0 }) };
    },
  }),
  writeTool({
    name: "undo",
    title: "Undo a change",
    description: `Reverses an earlier change (by its changeId) made through any assistant in the last ${UNDO_DAYS} days, unless those settings have changed again since. Returns a new changeId; then call confirm_change.`,
    inputSchema: { changeId: changeIdInput("The changeId the change returned.") },
    annotations: { ...MAY_SILENCE, idempotentHint: false },
    async plan(ctx, args) {
      trace(ctx, { undoneChangeId: args.changeId });
      const activityRef = refs.activity(ctx.db, ctx.uid).doc(args.changeId);
      const activity = await activityRef.get();
      const missing = `No change with that changeId in the last ${UNDO_DAYS} days.`;
      if (!activity.exists) throw new ToolError(missing);
      const original = activity.data();
      const originalIds = Object.keys(original.records ?? {}).filter(isRecordId);
      if (!originalIds.length) throw new ToolError("That change has nothing to undo.");
      // Turning vibration back off is judged against the alert type, so it is read too.
      const recordIds = originalIds.includes("p_vibration_enabled") && !originalIds.includes("p_alert_type")
        ? [...originalIds, "p_alert_type"] : originalIds;
      return {
        recordIds,
        summary: `Undid: ${original.summary}`,
        build: async (current, read) => {
          const fresh = await read(activityRef);
          if (!fresh.exists) throw new ToolError(missing);
          if (fresh.data().undoneAt) throw new ToolError("That change was already undone.");
          // Every change writes its records, so a missing occurrence record was deleted by a phone
          // after its event ended (firestore.rules); undo must not bring it back.
          if (originalIds.some((id) => id.startsWith("e_") && current[id] === null)) {
            throw new ToolError("That event has ended, so there is nothing to undo.");
          }
          // Compared by meaning: a phone re-encoding the same setting doesn't block undo.
          if (originalIds.some((id) => !samePayload(id, current[id], original.records[id].after))) {
            throw new ToolError("Those settings have changed again since, so undo would overwrite newer changes. Make the change you want directly instead.");
          }
          return Object.fromEntries(originalIds.map((id) => {
            const before = original.records[id].before;
            // The record didn't exist before: write the value that means "not set".
            if (before === null || before === undefined) return [id, id.startsWith("c_") ? {} : null];
            try {
              return [id, validatePayload(id, before)];
            } catch (error) {
              if (error instanceof RecordError) throw new ToolError("That change can't be undone: the setting it replaced is no longer valid.");
              throw error;
            }
          }));
        },
        // Guarded like the values, so two concurrent undos cannot both succeed.
        afterWrite: (batch, snapshotOf) => batch.update(activityRef, { undoneAt: new Date(ctx.now()) }, { lastUpdateTime: snapshotOf(activityRef).updateTime }),
        finish: (out) => {
          if (out.data.changed) ctx.count("undos");
        },
      };
    },
  }),
];

module.exports = { TOOLS, changeIdInput };

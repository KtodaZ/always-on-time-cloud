"use strict";

// Read tools: upcoming alarms, event search and explanations, calendars, settings and history.
// They answer from the phone's latest snapshot and the account's synced records.

const z = require("zod");

const {
  DAY_MS, HISTORY_DAYS, SNAPSHOT_WINDOW_DAYS, readDevices, readValues, refs, toMillis,
} = require("./assistant-data");
const {
  PAUSED_UNTIL, PREFERENCE_NAMES, RETIRED_PREFERENCES, isRecordId,
} = require("./assistant-records");
const {
  SETTINGS, describePause, leadTimesText, parseStored, tidyLeadTimes,
} = require("./assistant-settings");
const {
  ToolError, appLink, basedOn, basis, calendarName, cleanText, formatTime, isoLocal, minutesLabel, parseTime, quoted,
  resolveCalendar, resolveEvent, searchEvents, shortKey,
} = require("./assistant-snapshot");
const {
  accountEmails, hasPlus, latestSnapshot, requireSnapshot, result,
} = require("./assistant-tool-context");

const MAX_LIST = 100;
const MAX_EVENTS = 20;
const MAX_HISTORY = 50;
// How many of the newest history entries one call reads, before filtering by days and title.
const HISTORY_READ_LIMIT = MAX_HISTORY * 4;
const MAX_RANGE_DAYS = SNAPSHOT_WINDOW_DAYS + 1;

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const eventInputs = {
  event: z.string().max(80).optional().describe("Event key (e_...) from find_events or list_upcoming_alarms; the short form shown in results works too."),
  googleCalendarId: z.string().max(300).optional().describe("Google Calendar calendarId (e.g. the user's email for their primary calendar)."),
  googleEventId: z.string().max(1100).optional().describe("Google Calendar event id. For one occurrence of a recurring event use the instance id (seriesId_20261020T150000Z)."),
  recurringEventId: z.string().max(1100).optional().describe("Google recurringEventId of an occurrence, if the connector gave one."),
  originalStartTime: z.string().max(40).optional().describe("Google originalStartTime (dateTime or date) of an occurrence, if the connector gave one."),
};

function alarmView(alarm, snapshot) {
  return {
    at: isoLocal(alarm.at, snapshot.timeZone),
    atMillis: alarm.at,
    kind: alarm.kind,
    minutes: alarm.minutes,
    source: alarm.source,
    status: alarm.status,
  };
}

function eventView(event, snapshot) {
  return {
    eventKey: event.eventKey,
    seriesKey: event.seriesKey,
    calendarKey: event.calendarKey,
    calendar: calendarName(snapshot, event.calendarKey),
    title: event.title,
    start: isoLocal(event.start, snapshot.timeZone),
    end: Number.isFinite(event.end) ? isoLocal(event.end, snapshot.timeZone) : null,
    allDay: event.allDay,
    recurring: event.recurring,
    rsvp: event.rsvp,
    alarms: event.alarms.map((alarm) => alarmView(alarm, snapshot)),
  };
}

const keyNote = (event) => (event.eventKey ? ` [${shortKey(event.eventKey)}]` : " [no key: change it in the app]");

function alarmDescription(alarm) {
  if (alarm.kind === "travel") return alarm.minutes ? `${alarm.minutes} min before leaving` : "time to leave";
  return minutesLabel(alarm.minutes ?? 0);
}

const SOURCE_TEXT = {
  app: "the app's default lead times",
  calendar: "the calendar's lead times",
  series: "the rule for this recurring series",
  event: "a setting for this occurrence only",
  travel: "the travel plan",
};

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

const TOOLS = [
  {
    name: "list_upcoming_alarms",
    title: "Upcoming alarms",
    description: `Alarms that will ring in a time range (default: the next 24 hours), in ring order, for events on watched calendars up to ${SNAPSHOT_WINDOW_DAYS} days ahead. Times without an offset are in the phone's time zone. Answers questions like "what rings tomorrow?". Turned-off alarms are left out unless includeOff is true.`,
    inputSchema: {
      from: z.string().max(40).optional().describe("Start, ISO 8601 (e.g. 2026-10-20 or 2026-10-20T09:00). Default: now."),
      to: z.string().max(40).optional().describe(`End, ISO 8601. Default: 24 hours after from. At most ${MAX_RANGE_DAYS} days after from.`),
      calendar: z.string().max(300).optional().describe("Only this calendar: its key, name, or Google calendarId."),
      includeOff: z.boolean().optional().describe("Also list alarms that are turned off for their event."),
    },
    annotations: READ,
    scope: "read",
    async handler(ctx, args) {
      const snapshot = await requireSnapshot(ctx);
      const now = ctx.now();
      const from = args.from ? parseTime(args.from, snapshot.timeZone, "from") : now;
      const to = args.to ? parseTime(args.to, snapshot.timeZone, "to") : from + DAY_MS;
      if (to <= from) throw new ToolError("to must be after from.");
      if (to - from > MAX_RANGE_DAYS * DAY_MS) throw new ToolError(`The range can be at most ${MAX_RANGE_DAYS} days.`);
      const calendar = args.calendar ? resolveCalendar(snapshot, args.calendar, { accountEmails: await accountEmails(ctx) }) : null;
      const alarms = [];
      for (const event of snapshot.events) {
        if (calendar && event.calendarKey !== calendar.key) continue;
        for (const alarm of event.alarms) {
          if (alarm.at < from || alarm.at >= to || alarm.status === "past") continue;
          if (!args.includeOff && alarm.status === "off") continue;
          alarms.push({ alarm, event });
        }
      }
      alarms.sort((a, b) => a.alarm.at - b.alarm.at);
      const shown = alarms.slice(0, MAX_LIST);
      const range = `${formatTime(from, snapshot.timeZone)} and ${formatTime(to, snapshot.timeZone)}`;
      const lines = [basis(snapshot, now)];
      if (!shown.length) {
        const on = calendar ? ` on ${calendar.calendar?.name ? quoted(calendar.calendar.name) : "that calendar"}` : "";
        lines.push(`No alarms ring between ${range}${on} on watched calendars. An event may be on a calendar the app doesn't watch (see list_calendars) or filtered out by RSVP or all-day settings.`);
      } else {
        lines.push(`${plural(alarms.length, "alarm")} between ${range}${alarms.length > shown.length ? ` (first ${shown.length} shown)` : ""}:`);
        for (const { alarm, event } of shown) {
          const status = alarm.status === "paused" ? " (paused)" : alarm.status === "off" ? " (off)" : "";
          lines.push(`- ${formatTime(alarm.at, snapshot.timeZone)}: ${quoted(event.title)}, ${alarmDescription(alarm)}${status}${keyNote(event)}`);
        }
      }
      if (snapshot.windowEnd && to > snapshot.windowEnd) {
        lines.push(`The phone shares events through ${formatTime(snapshot.windowEnd, snapshot.timeZone)} (${SNAPSHOT_WINDOW_DAYS} days).`);
      }
      return result(lines.join("\n"), {
        basedOn: basedOn(snapshot),
        timeZone: snapshot.timeZone,
        total: alarms.length,
        alarms: shown.map(({ alarm, event }) => ({
          ...alarmView(alarm, snapshot), title: event.title, eventKey: event.eventKey,
          seriesKey: event.seriesKey, calendar: calendarName(snapshot, event.calendarKey),
        })),
      });
    },
  },
  {
    name: "find_events",
    title: "Find events",
    description: `Searches event titles on watched calendars in the next ${SNAPSHOT_WINDOW_DAYS} days and returns their keys and alarms. Use the keys with explain_alarm, set_event_alarms or set_series_alarms. It only knows titles and times.`,
    inputSchema: {
      query: z.string().min(1).max(100).describe("Words from the event title (all must match, any case)."),
      from: z.string().max(40).optional().describe("Earliest start, ISO 8601. Default: now."),
      to: z.string().max(40).optional().describe(`Latest start, ISO 8601. Default: the end of the phone's ${SNAPSHOT_WINDOW_DAYS}-day window.`),
    },
    annotations: READ,
    scope: "read",
    async handler(ctx, args) {
      const snapshot = await requireSnapshot(ctx);
      const now = ctx.now();
      const from = args.from ? parseTime(args.from, snapshot.timeZone, "from") : now;
      const to = args.to ? parseTime(args.to, snapshot.timeZone, "to") : Infinity;
      const inRange = snapshot.events.filter((event) => (event.end ?? event.start) >= from && event.start <= to);
      const matches = searchEvents(inRange, args.query);
      const shown = matches.slice(0, MAX_EVENTS);
      const lines = [basis(snapshot, now)];
      if (!shown.length) {
        lines.push(`No matching event in the next ${SNAPSHOT_WINDOW_DAYS} days on watched calendars. It may be further out or on a calendar the app doesn't watch; list_calendars shows which calendars are watched.`);
      } else {
        lines.push(`${plural(matches.length, "matching event")}${matches.length > shown.length ? ` (first ${MAX_EVENTS} shown)` : ""}:`);
        for (const event of shown) {
          const on = event.alarms.filter((alarm) => alarm.status === "on" || alarm.status === "paused");
          const alarmText = on.length ? `rings ${on.map(alarmDescription).join(", ")}` : "no alarms";
          const calendar = calendarName(snapshot, event.calendarKey);
          lines.push(`- ${quoted(event.title)}: ${formatTime(event.start, snapshot.timeZone)}${calendar ? `, ${quoted(calendar)}` : ""}${event.recurring ? ", repeats" : ""}; ${alarmText}${keyNote(event)}`);
        }
      }
      return result(lines.join("\n"), {
        basedOn: basedOn(snapshot),
        total: matches.length,
        events: shown.map((event) => eventView(event, snapshot)),
      });
    },
  },
  {
    name: "explain_alarm",
    title: "Explain an event's alarms",
    description: "Explains when an event's alarms ring and which setting decides each one (this occurrence, its recurring series, its calendar, the app default, or a travel plan), or why it has none. Name the event by key or by Google Calendar ids.",
    inputSchema: eventInputs,
    annotations: READ,
    scope: "read",
    async handler(ctx, args) {
      const snapshot = await requireSnapshot(ctx);
      const now = ctx.now();
      const resolved = resolveEvent(snapshot, args, { accountEmails: await accountEmails(ctx) });
      const event = resolved.event;
      if (!event) {
        return result(`${basis(snapshot, now)}\nThat event isn't in what the phone shared. Either it is more than ${SNAPSHOT_WINDOW_DAYS} days away, on a calendar the app doesn't watch, filtered out (declined invitations or all-day events, depending on settings), or not on this phone. list_calendars shows which calendars ring.`, { found: false });
      }
      const ids = [event.eventKey, event.seriesKey, event.calendarKey].filter(isRecordId);
      const docs = await Promise.all(ids.map((id) => refs.values(ctx.db, ctx.uid).doc(id).get()));
      // Only connector writes carry updatedAt; values a phone wrote are already on that phone.
      const pending = docs.some((doc) => doc.exists && (toMillis(doc.data().updatedAt) ?? 0) > snapshot.valuesAppliedThrough);
      const devices = await readDevices(ctx.db, ctx.uid);
      const calendar = calendarName(snapshot, event.calendarKey);
      const lines = [basis(snapshot, now), `${quoted(event.title)}: ${formatTime(event.start, snapshot.timeZone)}${calendar ? ` on ${quoted(calendar)}` : ""}${event.recurring ? " (repeats)" : ""}.`];
      if (!event.alarms.length) {
        lines.push("It has no alarms: its settings leave no lead times. Use set_event_alarms or set_series_alarms to add some.");
      }
      for (const alarm of event.alarms) {
        const source = alarm.source === "calendar" && calendar ? `the ${quoted(calendar)} calendar's lead times` : SOURCE_TEXT[alarm.source] ?? "the app";
        const status = alarm.status === "off" ? "; turned off for this event"
          : alarm.status === "paused" ? `; paused (alarms are ${describePause(snapshot.paused.until, snapshot.timeZone)})`
            : alarm.status === "past" ? "; already passed" : "";
        lines.push(`- ${formatTime(alarm.at, snapshot.timeZone, { timeOnly: true })}: ${alarmDescription(alarm)}, from ${source}${status}.`);
      }
      lines.push("The most specific setting wins: this occurrence, then its series, then its calendar, then the app default.");
      if (pending) lines.push("A newer change to this event's settings hasn't reached the phone yet; refresh or confirm_change will show when it has.");
      const data = { found: true, event: eventView(event, snapshot), pendingChange: pending };
      // `plus` is reported by phones with Plus benefits (subscribed, or while Plus is free).
      if (event.alarms.some((alarm) => alarm.kind === "travel") && !hasPlus(devices)) {
        const link = appLink(ctx.origin, "plus");
        ctx.count("plusGate");
        lines.push(`Leave times use the travel estimate saved on the phone; live traffic updates need Always On Time Plus: ${link}`);
        data.links = { plus: link };
      }
      return result(lines.join("\n"), data);
    },
  },
  {
    name: "list_calendars",
    title: "Calendars on the phone",
    description: "Every calendar on the phone, watched or not, with its alarm settings and key. Local-only calendars are listed but can only be changed in the app. Adding a calendar account happens in the phone's settings, not here.",
    inputSchema: {},
    annotations: READ,
    scope: "read",
    async handler(ctx) {
      const snapshot = await requireSnapshot(ctx);
      // Ring-through is an Android-only calendar override that the snapshot doesn't carry, so it
      // comes from the calendar's synced record.
      const keys = [...new Set(snapshot.calendars.map((calendar) => calendar.key).filter(Boolean))];
      const records = await readValues(ctx.db, ctx.uid, keys);
      const ringsThrough = (calendar) => Boolean(calendar.key) && parseStored(records[calendar.key])?.overrides?.ringThroughDnd === true;
      const lines = [basis(snapshot, ctx.now())];
      const kind = (type) => (type === "com.google" ? "Google" : type === "LOCAL" || !type ? "local" : /exchange/i.test(type) ? "Exchange" : "other");
      for (const calendar of snapshot.calendars) {
        const settings = [];
        if (Array.isArray(calendar.leadTimes)) settings.push(`rings ${leadTimesText(tidyLeadTimes(calendar.leadTimes))}`);
        if (calendar.enabled === false) settings.push("alarms off");
        if (calendar.rsvpFilter) settings.push(`invitations: ${calendar.rsvpFilter.replace(/_/g, " ")}`);
        if (calendar.includeAllDay !== null) settings.push(`all-day events ${calendar.includeAllDay ? "ring" : "skipped"}`);
        if (ringsThrough(calendar)) settings.push("rings through Do Not Disturb");
        const key = calendar.key ? ` [${shortKey(calendar.key)}]` : " [local only: change it in the app]";
        lines.push(`- ${quoted(calendar.name || "Unnamed")} (${kind(calendar.accountType)}): ${calendar.watched ? "watched" : "not watched"}${settings.length ? `; ${settings.join("; ")}` : ""}${key}`);
      }
      if (!snapshot.calendars.length) lines.push("The phone reported no calendars. The app may not have calendar permission; open_in_app(\"permissions\") helps fix that.");
      return result(lines.join("\n"), {
        basedOn: basedOn(snapshot),
        calendars: snapshot.calendars.map((calendar) => ({
          key: calendar.key, name: calendar.name || null, accountType: calendar.accountType, watched: calendar.watched,
          leadTimes: calendar.leadTimes, enabled: calendar.enabled, rsvpFilter: calendar.rsvpFilter,
          includeAllDay: calendar.includeAllDay, ringsThroughDoNotDisturb: ringsThrough(calendar), changeable: Boolean(calendar.key),
        })),
      });
    },
  },
  {
    name: "get_settings",
    title: "App settings",
    description: "The app-wide alarm, snooze, spoken-alarm and appearance settings synced to the user's account. Settings not listed use the app's default. Sounds and voices are chosen on the phone (open_in_app \"settings/sounds\").",
    inputSchema: {},
    annotations: READ,
    scope: "read",
    async handler(ctx) {
      const recordIds = [...PREFERENCE_NAMES].filter((name) => !RETIRED_PREFERENCES.has(name)).map((name) => `p_${name}`);
      const values = await readValues(ctx.db, ctx.uid, recordIds);
      const settings = {};
      const lines = [];
      for (const [field, setting] of Object.entries(SETTINGS)) {
        const stored = parseStored(values[`p_${setting.record}`]);
        if (stored === null) continue;
        const shown = setting.decode ? setting.decode(stored) : stored;
        settings[field] = shown;
        lines.push(`- ${setting.label}: ${Array.isArray(shown) ? leadTimesText(tidyLeadTimes(shown)) : typeof shown === "string" ? cleanText(shown) : shown}`);
      }
      const paused = parseStored(values[`p_${PAUSED_UNTIL}`]);
      if (paused !== null) settings.alarmsPausedUntil = paused;
      const text = lines.length
        ? `Synced settings (others use the app default):\n${lines.join("\n")}`
        : "No app-wide settings have been synced yet, so the app defaults apply (or the phone hasn't synced them).";
      return result(text, { settings, raw: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null)) });
    },
  },
  {
    name: "get_alarm_history",
    title: "Alarm history",
    description: `What happened to alarms in the last 1-${HISTORY_DAYS} days: when each rang, snoozes, and how it was dismissed, per phone. Answers "did I snooze my 9am yesterday?".`,
    inputSchema: {
      days: z.number().int().min(1).max(HISTORY_DAYS).optional().describe(`How many days back (default 7, at most ${HISTORY_DAYS}).`),
      query: z.string().max(100).optional().describe("Only events whose title contains these words."),
    },
    annotations: READ,
    scope: "read",
    async handler(ctx, args) {
      const now = ctx.now();
      const days = args.days ?? 7;
      const snapshot = await latestSnapshot(ctx);
      const timeZone = snapshot?.timeZone ?? "UTC";
      // At most the newest HISTORY_READ_LIMIT entries in the window; the title filter runs here.
      const page = await refs.history(ctx.db, ctx.uid).where("createdAt", ">=", now - days * DAY_MS)
        .orderBy("createdAt", "desc").limit(HISTORY_READ_LIMIT).get();
      let entries = page.docs.map((doc) => parseStored(doc.data().payload))
        .filter((entry) => entry && typeof entry === "object" && Number.isFinite(entry.scheduledTime))
        .map((entry) => ({
          ...entry,
          title: cleanText(entry.title),
          deviceName: cleanText(entry.deviceName, 100) || null,
          action: cleanText(entry.action, 40) || null,
          snoozeCount: Number.isInteger(entry.snoozeCount) ? entry.snoozeCount : 0,
          snoozeMinutes: Number.isInteger(entry.snoozeMinutes) ? entry.snoozeMinutes : null,
        }));
      entries = searchEvents(entries, args.query).sort((a, b) => b.scheduledTime - a.scheduledTime);
      const shown = entries.slice(0, MAX_HISTORY);
      const lines = shown.map((entry) => {
        const parts = [];
        if (entry.snoozeCount) parts.push(`snoozed ${entry.snoozeCount}×${entry.snoozeMinutes ? ` (${entry.snoozeMinutes} min)` : ""}`);
        if (entry.action) parts.push(`${entry.action.toLowerCase().replace(/_/g, " ")}${Number.isFinite(entry.actionTime) ? ` at ${formatTime(entry.actionTime, timeZone, { timeOnly: true })}` : ""}`);
        if (!parts.length) parts.push(entry.firedTime ? "rang" : "scheduled");
        return `- ${formatTime(entry.scheduledTime, timeZone)}: ${quoted(entry.title)}: ${parts.join(", ")}${entry.deviceName ? ` (${entry.deviceName})` : ""}`;
      });
      const text = shown.length
        ? `Alarm history, last ${plural(days, "day")}${entries.length > shown.length ? ` (latest ${MAX_HISTORY})` : ""}:\n${lines.join("\n")}`
        : `No alarm history in the last ${plural(days, "day")}${args.query ? " for that title" : ""}. History syncs from phones signed in to the account.`;
      return result(text, {
        timeZone,
        total: entries.length,
        entries: shown.map((entry) => ({
          title: entry.title, scheduled: isoLocal(entry.scheduledTime, timeZone),
          fired: Number.isFinite(entry.firedTime) ? isoLocal(entry.firedTime, timeZone) : null,
          action: entry.action, actionTime: Number.isFinite(entry.actionTime) ? isoLocal(entry.actionTime, timeZone) : null,
          snoozeCount: entry.snoozeCount,
          snoozeMinutes: entry.snoozeMinutes,
          leadTimeMinutes: Number.isInteger(entry.leadTimeMinutes) ? entry.leadTimeMinutes : null,
          device: entry.deviceName,
        })),
      });
    },
  },
];

module.exports = { TOOLS, eventInputs };

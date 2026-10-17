"use strict";

// The assistant connector's MCP tools (product design: the app repository's docs/ASSISTANT_MCP.md).
// Reads come from the phone's published snapshot and the account's synced records; changes are
// written as account sync records, logged for undo, and announced to the phones over FCM.
// Every Firestore path is derived from ctx.uid, the uid of the verified access token.

const { randomBytes } = require("node:crypto");
const z = require("zod");

const {
  RawPayload, readDevices, readSnapshots, readValues, recordChange, refs, toMillis,
} = require("./assistant-data");
const { deviceName, sendToDevices } = require("./assistant-push");
const { PAUSED_UNTIL, PREFERENCE_NAMES, isRecordId } = require("./assistant-records");
const {
  ToolError, appLink, basis, calendarName, formatTime, isoLocal, minutesLabel, normalizeSnapshot, parseTime,
  relativeAge, resolveCalendar, resolveEvent, searchEvents, shortKey,
} = require("./assistant-snapshot");

const DAY_MS = 24 * 60 * 60 * 1000;
const POLL_MS = 1500;
const MAX_LIST = 100;

const INSTRUCTIONS = `Always On Time is the user's calendar alarm app on their phone. This connector lets you see and change when those alarms ring.

Setup first. If get_status says setup is not confirmed, call test_connection before anything else and tell the user the result. If no phone is connected, ask the user to open Always On Time on their phone (signed in with the same Google account) and give them the link.

Scope: alarms for events on calendars the app watches, up to 30 days ahead, plus the app's alarm settings and 14 days of alarm history. You cannot see event descriptions, attendees, locations or meeting links, cannot create or edit events, and cannot see calendars the phone doesn't have. For those, use the user's calendar connector, and suggest enabling Google Calendar if none is connected. Calendar connector ids work here too: pass googleCalendarId and googleEventId instead of an event key.

Answers come from the phone's latest snapshot; say what they are based on (the "As of ... from ..." line). Changes are saved to the user's account and sent to the phone: after a change, call confirm_change and only tell the user it is done on the phone once it is confirmed; otherwise say it is saved and will apply when the phone is online. Every change can be reversed with undo.

Some things need the phone itself (sounds, voices, permissions, battery settings): give the open_in_app link. The connector never turns on Always On Time Plus; if the user wants live traffic, say it needs Always On Time Plus and give open_in_app("plus").`;

// ---- Shared helpers ------------------------------------------------------------------------------

const eventInputs = {
  event: z.string().max(80).optional().describe("Event key (e_...) from find_events or list_upcoming_alarms; the short form shown in results works too."),
  googleCalendarId: z.string().max(300).optional().describe("Google Calendar calendarId from the calendar connector (e.g. the user's email for their primary calendar)."),
  googleEventId: z.string().max(1100).optional().describe("Google Calendar event id. For one occurrence of a recurring event use the instance id (seriesId_20261020T150000Z)."),
  recurringEventId: z.string().max(1100).optional().describe("Google recurringEventId of an occurrence, if the connector gave one."),
  originalStartTime: z.string().max(40).optional().describe("Google originalStartTime (dateTime or date) of an occurrence, if the connector gave one."),
};

const leadTimesInput = z.array(z.number().int().min(0).max(10080)).min(1).max(4)
  .describe("Minutes before the start for each alarm, e.g. [10, 0] rings 10 minutes before and at the start. 1-4 alarms, up to 7 days (10080) before.");

const tidyLeadTimes = (list) => [...new Set(list)].sort((a, b) => b - a);
const leadTimesText = (list) => (list.length ? list.map(minutesLabel).join(", ") : "no alarms");

function result(text, data = {}) {
  return { text, data };
}

async function loadSnapshots(ctx) {
  const snapshots = (await readSnapshots(ctx.db, ctx.uid)).filter((item) => item.payload && item.publishedAt);
  return snapshots.map(normalizeSnapshot);
}

/** The newest snapshot, or null. */
async function latestSnapshot(ctx) {
  return (await loadSnapshots(ctx))[0] ?? null;
}

function noPhone(ctx) {
  const link = appLink(ctx.origin, "assistants");
  return result(
    `No phone has shared its alarms yet. Ask the user to open Always On Time on their phone, signed in with the same Google account; it finishes connecting automatically. Then try again. Link: ${link}`,
    { needsPhone: true, links: { assistants: link } },
  );
}

async function requireSnapshot(ctx) {
  const snapshot = await latestSnapshot(ctx);
  if (!snapshot) throw Object.assign(new Error("no snapshot"), { noPhone: true });
  return snapshot;
}

async function accountEmails(ctx) {
  try {
    return await ctx.accountEmails();
  } catch {
    return [];
  }
}

function alarmView(alarm, event, snapshot) {
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
    eventKey: event.eventKey ?? null,
    seriesKey: event.seriesKey ?? null,
    calendarKey: event.calendarKey ?? null,
    calendar: calendarName(snapshot, event.calendarKey),
    title: event.title ?? "",
    start: isoLocal(event.start, snapshot.timeZone),
    end: Number.isFinite(event.end) ? isoLocal(event.end, snapshot.timeZone) : null,
    allDay: Boolean(event.allDay),
    recurring: Boolean(event.recurring),
    rsvp: event.rsvp ?? null,
    alarms: event.alarms.map((alarm) => alarmView(alarm, event, snapshot)),
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

const hasPlus = (devices) => devices.some((device) => Array.isArray(device.capabilities) && device.capabilities.includes("plus"));

/** Sends an FCM hint unless this connection has used up its push allowance. */
async function push(ctx, type, data, devices) {
  if (!(await ctx.pushAllowed())) {
    ctx.count("rateLimited");
    return { limited: true, sent: [], failed: [], removed: [], noToken: devices ?? [] };
  }
  return sendToDevices({ db: ctx.db, messaging: ctx.messaging, logger: ctx.logger }, ctx.uid, type, data, devices);
}

const names = (devices) => devices.map(deviceName).join(", ");

async function sleepUntil(ctx, deadline, check) {
  for (;;) {
    const done = await check();
    if (done) return done;
    if (ctx.now() + POLL_MS > deadline) return null;
    await ctx.sleep(POLL_MS);
  }
}

/** Saves a change, logs it for undo and nudges the phones. */
async function applyChange(ctx, { recordIds, build, tool, summary, afterWrite }) {
  const { changeId, records } = await recordChange(ctx.db, ctx.uid, {
    recordIds, build, assistant: ctx.grant.clientName, tool, summary, now: ctx.now(), afterWrite,
  });
  if (!changeId) return result("That is already how it's set; nothing changed.", { changed: false });
  ctx.count("changes");
  const devices = await readDevices(ctx.db, ctx.uid);
  const sent = await push(ctx, "sync", { changeId }, devices);
  let delivery;
  if (sent.sent.length) delivery = `Sent to ${names(sent.sent)}; call confirm_change with this changeId to check the phone applied it.`;
  else if (!devices.length) delivery = "No phone is connected yet; the change applies when Always On Time next syncs on the user's phone.";
  else delivery = "The phone couldn't be reached right now; it applies the change the next time Always On Time syncs (opening the app does it).";
  return result(`${summary}. Saved as change ${changeId}. ${delivery} It can be reversed with undo.`, {
    changed: true, changeId, records: Object.keys(records), sentTo: sent.sent.map(deviceName),
  });
}

/**
 * When a change was written, in ms. Normally its activity entry's writtenAt; if the server stopped
 * before recording it, the values' own update time (while they still hold what the change wrote).
 */
async function changeWriteTime(ctx, activity) {
  const recorded = toMillis(activity.writtenAt);
  if (recorded !== null) return recorded;
  const ids = Object.keys(activity.records ?? {}).filter(isRecordId);
  const docs = await Promise.all(ids.map((id) => refs.values(ctx.db, ctx.uid).doc(id).get()));
  const times = docs.filter((doc, index) => doc.exists && doc.data().payload === activity.records[ids[index]].after)
    .map((doc) => toMillis(doc.updateTime)).filter((time) => time !== null);
  if (!times.length) throw new ToolError("That change has since been replaced by a newer one.");
  return Math.max(...times);
}

const parseStored = (payload) => {
  if (payload === null || payload === undefined) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
};

/** Builds an Override for set/off/reset from the stored one, keeping fields the assistant doesn't manage. */
function nextOverride(stored, mode, leadTimes, currentLeadTimes) {
  if (mode === "reset") return null;
  const base = stored && typeof stored === "object" ? { ...stored } : {};
  if (mode === "off") {
    return { ...base, leadTimes: base.leadTimes ?? currentLeadTimes ?? [], enabled: false };
  }
  const next = { ...base, leadTimes, enabled: true };
  const added = (base.addedLeadTimes ?? []).filter((minutes) => leadTimes.includes(minutes));
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

const currentLeadMinutes = (event) => (event ? tidyLeadTimes(event.alarms.filter((alarm) => alarm.kind === "lead").map((alarm) => alarm.minutes ?? 0)) : null);

// ---- Settings vocabulary --------------------------------------------------------------------------

const SETTINGS = {
  defaultLeadTimes: { record: "default_lead_times_csv", label: "Default alarms", schema: leadTimesInput.describe("Default alarms for every event, in minutes before the start (1-4)."), encode: (value) => JSON.stringify([...new Set(value)].sort((a, b) => a - b)) },
  alarmVolume: { record: "alarm_volume", label: "Alarm volume (%)", schema: z.number().int().min(0).max(100) },
  alarmDurationSeconds: { record: "alarm_duration_seconds", label: "Ring for (seconds, 0 = until dismissed)", schema: z.number().int().min(0).max(86400) },
  gradualVolume: { record: "gradual_volume_enabled", label: "Gradually increase volume", schema: z.boolean() },
  vibration: { record: "vibration_enabled", label: "Vibrate", schema: z.boolean() },
  alertType: { record: "alert_type", label: "Alert type", schema: z.enum(["sound_and_vibration", "vibration_only", "visual_only"]) },
  snoozeMinutes: { record: "snooze_duration_minutes", label: "Snooze length (minutes)", schema: z.number().int().min(1).max(1440) },
  maxSnoozes: { record: "max_snoozes", label: "Maximum snoozes", schema: z.number().int().min(0).max(100) },
  smartSnoozeSuggestions: { record: "smart_snooze_suggestions", label: "Smart snooze suggestions", schema: z.boolean() },
  respectDoNotDisturb: { record: "respect_dnd", label: "Respect Do Not Disturb", schema: z.boolean() },
  overrideDndForPriority: { record: "override_dnd_for_priority", label: "Ring through Do Not Disturb for priority events", schema: z.boolean() },
  overrideSystemVolume: { record: "override_system_volume", label: "Override system volume", schema: z.boolean() },
  ignoreAllDayEvents: { record: "ignore_all_day_events", label: "Skip all-day events", schema: z.boolean() },
  rsvpFilter: { record: "rsvp_filter", label: "Which invitations ring", schema: z.enum(["accepted_only", "accepted_or_tentative", "not_declined", "all_events"]) },
  autoDetectMeetingLinks: { record: "auto_detect_meeting_urls", label: "Detect meeting links", schema: z.boolean() },
  spokenAlarmEventName: { record: "spoken_alarm_include_event_name", label: "Spoken alarm says the event name", schema: z.boolean() },
  spokenAlarmTimeUntil: { record: "spoken_alarm_include_time_until_event", label: "Spoken alarm says the time until the event", schema: z.boolean() },
  spokenAlarmLocation: { record: "spoken_alarm_include_location", label: "Spoken alarm says the location", schema: z.boolean() },
  spokenAlarmReminder: { record: "spoken_alarm_include_helpful_reminder", label: "Spoken alarm adds a helpful reminder", schema: z.boolean() },
  spokenAlarmSpeechRate: { record: "spoken_alarm_speech_rate_hundredths", label: "Speech rate (%)", schema: z.number().int().min(25).max(400) },
  theme: { record: "theme_preference", label: "Theme", schema: z.enum(["system", "light", "dark"]) },
  dynamicColor: { record: "dynamic_color", label: "Use wallpaper colors", schema: z.boolean() },
  applyAccentToApp: { record: "apply_accent_to_app", label: "Apply accent color to the app", schema: z.boolean() },
};

const RECORD_LABELS = Object.fromEntries(Object.values(SETTINGS).map((setting) => [setting.record, setting.label]));

function describePause(until, timeZone) {
  if (until === -1) return "paused until resumed";
  if (Number.isFinite(until) && until > 0) return `paused until ${formatTime(until, timeZone)}`;
  return "on";
}

// ---- Tools ----------------------------------------------------------------------------------------

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CHANGE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: "get_status",
    title: "Connection status",
    description: "Connected phones, when each last shared its alarms, whether alarms are paused, what each phone supports, and whether setup has been confirmed. Call this first in a conversation; if setup is not confirmed, call test_connection next.",
    inputSchema: {},
    annotations: READ,
    scope: "read",
    async handler(ctx) {
      const [devices, snapshots, values] = await Promise.all([
        readDevices(ctx.db, ctx.uid), loadSnapshots(ctx), readValues(ctx.db, ctx.uid, [`p_${PAUSED_UNTIL}`]),
      ]);
      const now = ctx.now();
      const latest = snapshots[0] ?? null;
      const timeZone = latest?.timeZone ?? "UTC";
      const ids = new Set([...devices.map((device) => device.id), ...snapshots.map((snapshot) => snapshot.deviceId)]);
      const phones = [...ids].map((id) => {
        const device = devices.find((item) => item.id === id) ?? { id };
        const snapshot = snapshots.find((item) => item.deviceId === id);
        return {
          deviceId: id,
          name: device.deviceName ?? snapshot?.device ?? "phone",
          platform: device.platform ?? null,
          appVersion: device.appVersion ?? null,
          capabilities: Array.isArray(device.capabilities) ? device.capabilities : [],
          canReceiveMessages: Boolean(device.fcmToken),
          lastSharedAt: snapshot ? isoLocal(snapshot.publishedAt, timeZone) : null,
          lastSharedMillis: snapshot?.publishedAt ?? null,
        };
      });
      const setupConfirmed = Boolean(ctx.grant.setupConfirmedAt);
      const pausedRecord = parseStored(values[`p_${PAUSED_UNTIL}`]);
      const pausedUntil = latest ? latest.paused.until ?? 0 : pausedRecord ?? 0;
      const lines = [`Connected as ${ctx.grant.clientName}.`];
      if (!phones.length) {
        const link = appLink(ctx.origin, "assistants");
        lines.push(`No phone has finished connecting. Ask the user to open Always On Time on their phone, signed in with the same Google account. Link: ${link}`);
        return result(lines.join("\n"), { setupConfirmed, phones, links: { assistants: link } });
      }
      lines.push(setupConfirmed
        ? `Setup confirmed ${formatTime(ctx.grant.setupConfirmedAt, timeZone)}.`
        : "Setup is not confirmed yet: call test_connection now and tell the user the result.");
      for (const phone of phones) {
        const shared = phone.lastSharedMillis ? `last shared alarms ${relativeAge(phone.lastSharedMillis, now)}` : "hasn't shared alarms yet";
        const parts = [phone.platform === "ios" ? "iPhone" : phone.platform === "android" ? "Android" : null, phone.appVersion ? `app ${phone.appVersion}` : null,
          phone.canReceiveMessages ? "can receive changes instantly" : "gets changes on its next sync", shared].filter(Boolean);
        lines.push(`Phone: ${phone.name} (${parts.join("; ")}).`);
      }
      lines.push(`Alarms are ${describePause(pausedUntil, timeZone)}.`);
      if (latest) lines.push(basis(latest, now));
      return result(lines.join("\n"), {
        setupConfirmed,
        phones,
        alarms: { paused: pausedUntil !== 0, pausedUntil: pausedUntil > 0 ? isoLocal(pausedUntil, timeZone) : pausedUntil === -1 ? "until resumed" : null },
        timeZone,
        plus: hasPlus(devices),
      });
    },
  },
  {
    name: "list_upcoming_alarms",
    title: "Upcoming alarms",
    description: "Alarms that will ring in a time range (default: the next 24 hours), in ring order, for events on watched calendars up to 30 days ahead. Times without an offset are in the phone's time zone. Answers questions like \"what rings tomorrow?\". Turned-off alarms are left out unless includeOff is true.",
    inputSchema: {
      from: z.string().max(40).optional().describe("Start, ISO 8601 (e.g. 2026-10-20 or 2026-10-20T09:00). Default: now."),
      to: z.string().max(40).optional().describe("End, ISO 8601. Default: 24 hours after from. At most 31 days after from."),
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
      if (to - from > 31 * DAY_MS) throw new ToolError("The range can be at most 31 days.");
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
        lines.push(`No alarms ring between ${range}${calendar ? ` on ${calendar.calendar?.name ?? "that calendar"}` : ""} on watched calendars. An event may be on a calendar the app doesn't watch (see list_calendars) or filtered out by RSVP or all-day settings.`);
      } else {
        lines.push(`${alarms.length} alarm${alarms.length === 1 ? "" : "s"} between ${range}${alarms.length > shown.length ? ` (first ${shown.length} shown)` : ""}:`);
        for (const { alarm, event } of shown) {
          const status = alarm.status === "paused" ? " (paused)" : alarm.status === "off" ? " (off)" : "";
          lines.push(`- ${formatTime(alarm.at, snapshot.timeZone)}: ${event.title ?? "Untitled"}, ${alarmDescription(alarm)}${status}${keyNote(event)}`);
        }
      }
      if (snapshot.windowEnd && to > snapshot.windowEnd) lines.push(`The phone shares events through ${formatTime(snapshot.windowEnd, snapshot.timeZone)} (30 days).`);
      return result(lines.join("\n"), {
        basedOn: { device: snapshot.device, publishedAt: isoLocal(snapshot.publishedAt, snapshot.timeZone) },
        timeZone: snapshot.timeZone,
        total: alarms.length,
        alarms: shown.map(({ alarm, event }) => ({
          ...alarmView(alarm, event, snapshot), title: event.title ?? "", eventKey: event.eventKey ?? null,
          seriesKey: event.seriesKey ?? null, calendar: calendarName(snapshot, event.calendarKey),
        })),
      });
    },
  },
  {
    name: "find_events",
    title: "Find events",
    description: "Searches event titles on watched calendars in the next 30 days and returns their keys and alarms. Use the keys with explain_alarm, set_event_alarms or set_series_alarms. It only knows titles and times; for anything else use the calendar connector.",
    inputSchema: {
      query: z.string().min(1).max(100).describe("Words from the event title (all must match, any case)."),
      from: z.string().max(40).optional().describe("Earliest start, ISO 8601. Default: now."),
      to: z.string().max(40).optional().describe("Latest start, ISO 8601. Default: the end of the phone's 30-day window."),
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
      const shown = matches.slice(0, 20);
      const lines = [basis(snapshot, now)];
      if (!shown.length) {
        lines.push("No matching event in the next 30 days on watched calendars. It may be further out or on a calendar the app doesn't watch; check the calendar connector or list_calendars.");
      } else {
        lines.push(`${matches.length} matching event${matches.length === 1 ? "" : "s"}${matches.length > shown.length ? " (first 20 shown)" : ""}:`);
        for (const event of shown) {
          const on = event.alarms.filter((alarm) => alarm.status === "on" || alarm.status === "paused");
          const alarmText = on.length ? `rings ${on.map(alarmDescription).join(", ")}` : "no alarms";
          const calendar = calendarName(snapshot, event.calendarKey);
          lines.push(`- ${event.title ?? "Untitled"}: ${formatTime(event.start, snapshot.timeZone)}${calendar ? `, ${calendar}` : ""}${event.recurring ? ", repeats" : ""}; ${alarmText}${keyNote(event)}`);
        }
      }
      return result(lines.join("\n"), {
        basedOn: { device: snapshot.device, publishedAt: isoLocal(snapshot.publishedAt, snapshot.timeZone) },
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
        return result(`${basis(snapshot, now)}\nThat event isn't in what the phone shared. Either it is more than 30 days away, on a calendar the app doesn't watch, filtered out (declined invitations or all-day events, depending on settings), or not on this phone. list_calendars shows which calendars ring.`, { found: false });
      }
      const ids = [event.eventKey, event.seriesKey, event.calendarKey].filter(isRecordId);
      const docs = await Promise.all(ids.map((id) => refs.values(ctx.db, ctx.uid).doc(id).get()));
      // Only connector writes carry updatedAt; values a phone wrote are already on that phone.
      const pending = docs.some((doc) => doc.exists && (toMillis(doc.data().updatedAt) ?? 0) > snapshot.valuesAppliedThrough);
      const devices = await readDevices(ctx.db, ctx.uid);
      const calendar = calendarName(snapshot, event.calendarKey);
      const lines = [basis(snapshot, now), `${event.title ?? "Untitled"}: ${formatTime(event.start, snapshot.timeZone)}${calendar ? ` on ${calendar}` : ""}${event.recurring ? " (repeats)" : ""}.`];
      if (!event.alarms.length) {
        lines.push("It has no alarms: its settings leave no lead times. Use set_event_alarms or set_series_alarms to add some.");
      }
      for (const alarm of event.alarms) {
        const source = alarm.source === "calendar" && calendar ? `the "${calendar}" calendar's lead times` : SOURCE_TEXT[alarm.source] ?? "the app";
        const status = alarm.status === "off" ? "; turned off for this event"
          : alarm.status === "paused" ? `; paused (alarms are ${describePause(snapshot.paused.until, snapshot.timeZone)})`
            : alarm.status === "past" ? "; already passed" : "";
        lines.push(`- ${formatTime(alarm.at, snapshot.timeZone, { timeOnly: true })}: ${alarmDescription(alarm)}, from ${source}${status}.`);
      }
      lines.push("The most specific setting wins: this occurrence, then its series, then its calendar, then the app default.");
      if (pending) lines.push("A newer change to this event's settings hasn't reached the phone yet; refresh or confirm_change will show when it has.");
      const data = { found: true, event: eventView(event, snapshot), pendingChange: pending };
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
      const lines = [basis(snapshot, ctx.now())];
      const kind = (type) => (type === "com.google" ? "Google" : type === "LOCAL" || !type ? "local" : /exchange/i.test(type) ? "Exchange" : type);
      for (const calendar of snapshot.calendars) {
        const settings = [];
        if (Array.isArray(calendar.leadTimes)) settings.push(`rings ${leadTimesText(calendar.leadTimes)}`);
        if (calendar.enabled === false) settings.push("alarms off");
        if (calendar.rsvpFilter) settings.push(`invitations: ${String(calendar.rsvpFilter).toLowerCase().replace(/_/g, " ")}`);
        if (calendar.includeAllDay !== undefined) settings.push(`all-day events ${calendar.includeAllDay ? "ring" : "skipped"}`);
        const key = calendar.key ? ` [${shortKey(calendar.key)}]` : " [local only: change it in the app]";
        lines.push(`- ${calendar.name ?? "Unnamed"} (${kind(calendar.accountType)}): ${calendar.watched ? "watched" : "not watched"}${settings.length ? `; ${settings.join("; ")}` : ""}${key}`);
      }
      if (!snapshot.calendars.length) lines.push("The phone reported no calendars. The app may not have calendar permission; open_in_app(\"permissions\") helps fix that.");
      return result(lines.join("\n"), {
        basedOn: { device: snapshot.device, publishedAt: isoLocal(snapshot.publishedAt, snapshot.timeZone) },
        calendars: snapshot.calendars.map((calendar) => ({
          key: calendar.key ?? null, name: calendar.name ?? null, accountType: calendar.accountType ?? null, watched: Boolean(calendar.watched),
          leadTimes: calendar.leadTimes ?? null, enabled: calendar.enabled ?? null, rsvpFilter: calendar.rsvpFilter ?? null,
          includeAllDay: calendar.includeAllDay ?? null, changeable: Boolean(calendar.key),
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
      const recordIds = [...PREFERENCE_NAMES].map((name) => `p_${name}`);
      const values = await readValues(ctx.db, ctx.uid, recordIds);
      const settings = {};
      const lines = [];
      for (const [field, setting] of Object.entries(SETTINGS)) {
        const value = parseStored(values[`p_${setting.record}`]);
        if (value === null) continue;
        const shown = field === "defaultLeadTimes" ? (() => {
          const list = parseStored(value);
          return Array.isArray(list) ? list : value;
        })() : value;
        settings[field] = shown;
        lines.push(`- ${setting.label}: ${Array.isArray(shown) ? leadTimesText(tidyLeadTimes(shown)) : shown}`);
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
    description: "What happened to alarms in the last 1-14 days: when each rang, snoozes, and how it was dismissed, per phone. Answers \"did I snooze my 9am yesterday?\".",
    inputSchema: {
      days: z.number().int().min(1).max(14).optional().describe("How many days back (default 7, at most 14)."),
      query: z.string().max(100).optional().describe("Only events whose title contains these words."),
    },
    annotations: READ,
    scope: "read",
    async handler(ctx, args) {
      const now = ctx.now();
      const days = args.days ?? 7;
      const snapshot = await latestSnapshot(ctx);
      const timeZone = snapshot?.timeZone ?? "UTC";
      const page = await refs.history(ctx.db, ctx.uid).where("createdAt", ">=", now - days * DAY_MS).get();
      let entries = page.docs.map((doc) => parseStored(doc.data().payload)).filter((entry) => entry && Number.isFinite(entry.scheduledTime));
      entries = searchEvents(entries, args.query).sort((a, b) => b.scheduledTime - a.scheduledTime);
      const shown = entries.slice(0, 50);
      const lines = shown.map((entry) => {
        const parts = [];
        if (entry.snoozeCount) parts.push(`snoozed ${entry.snoozeCount}×${entry.snoozeMinutes ? ` (${entry.snoozeMinutes} min)` : ""}`);
        if (entry.action) parts.push(`${String(entry.action).toLowerCase().replace(/_/g, " ")}${entry.actionTime ? ` at ${formatTime(entry.actionTime, timeZone, { timeOnly: true })}` : ""}`);
        if (!parts.length) parts.push(entry.firedTime ? "rang" : "scheduled");
        return `- ${formatTime(entry.scheduledTime, timeZone)}: ${entry.title ?? "Untitled"}: ${parts.join(", ")}${entry.deviceName ? ` (${entry.deviceName})` : ""}`;
      });
      const text = shown.length
        ? `Alarm history, last ${days} day${days === 1 ? "" : "s"}${entries.length > shown.length ? " (latest 50)" : ""}:\n${lines.join("\n")}`
        : `No alarm history in the last ${days} day${days === 1 ? "" : "s"}${args.query ? " for that title" : ""}. History syncs from phones signed in to the account.`;
      return result(text, {
        timeZone,
        total: entries.length,
        entries: shown.map((entry) => ({
          title: entry.title ?? "", scheduled: isoLocal(entry.scheduledTime, timeZone),
          fired: Number.isFinite(entry.firedTime) ? isoLocal(entry.firedTime, timeZone) : null,
          action: entry.action ?? null, actionTime: Number.isFinite(entry.actionTime) ? isoLocal(entry.actionTime, timeZone) : null,
          snoozeCount: entry.snoozeCount ?? 0, snoozeMinutes: entry.snoozeMinutes ?? null, leadTimeMinutes: entry.leadTimeMinutes ?? null,
          device: entry.deviceName ?? null,
        })),
      });
    },
  },
  {
    name: "set_event_alarms",
    title: "Set alarms for one event",
    description: "Changes the alarms for one event occurrence only: set lead times, turn its alarms off, or reset it to follow its series, calendar and app settings. For every occurrence of a recurring event use set_series_alarms. Returns a changeId; then call confirm_change.",
    inputSchema: {
      ...eventInputs,
      mode: z.enum(["set", "off", "reset"]).optional().describe("set (default; needs leadTimes), off (no alarms for this occurrence), or reset (follow the series/calendar/app settings again)."),
      leadTimes: leadTimesInput.optional(),
    },
    annotations: CHANGE,
    scope: "write",
    async handler(ctx, args) {
      const mode = modeOf(args);
      const snapshot = await latestSnapshot(ctx);
      const resolved = resolveEvent(snapshot, args, { accountEmails: await accountEmails(ctx) });
      const event = resolved.event;
      if (event && event.start <= ctx.now()) throw new ToolError("That event has already started, so its alarms can't change.");
      const leadTimes = args.leadTimes ? tidyLeadTimes(args.leadTimes) : null;
      const label = event ? `"${event.title ?? "Untitled"}" (${formatTime(event.start, snapshot.timeZone)})` : "that event";
      const summary = mode === "set" ? `Set ${label} to ring ${leadTimesText(leadTimes)}`
        : mode === "off" ? `Turned off alarms for ${label}` : `Reset ${label} to follow its usual settings`;
      const out = await applyChange(ctx, {
        recordIds: [resolved.eventKey],
        tool: "set_event_alarms",
        summary,
        build: (current) => ({
          [resolved.eventKey]: nextOverride(parseStored(current[resolved.eventKey]), mode, leadTimes, currentLeadMinutes(event)),
        }),
      });
      if (!event) out.text += " That event isn't in what the phone shared yet, so it applies once the phone sees it.";
      out.data.eventKey = resolved.eventKey;
      return out;
    },
  },
  {
    name: "set_series_alarms",
    title: "Set alarms for a recurring series",
    description: "Changes the alarms for every occurrence of a recurring event: set lead times, turn them off, or reset to follow the calendar and app settings. Occurrences with their own setting keep it. Name the series by any of its event keys, its series key, or Google ids. Returns a changeId; then call confirm_change.",
    inputSchema: {
      ...eventInputs,
      event: z.string().max(80).optional().describe("Any event key (e_...) of the series, or its series key (s_...)."),
      mode: z.enum(["set", "off", "reset"]).optional().describe("set (default; needs leadTimes), off, or reset (follow the calendar/app settings)."),
      leadTimes: leadTimesInput.optional(),
    },
    annotations: CHANGE,
    scope: "write",
    async handler(ctx, args) {
      const mode = modeOf(args);
      const snapshot = await latestSnapshot(ctx);
      const resolved = resolveEvent(snapshot, args, { accountEmails: await accountEmails(ctx), needOccurrence: false });
      if (!resolved.seriesKey) throw new ToolError("That event isn't in what the phone shared, so its series is unknown. Use find_events, or Google Calendar ids from the calendar connector.");
      if (resolved.recurring === false || (resolved.event && !resolved.event.recurring)) {
        throw new ToolError("That event doesn't repeat; use set_event_alarms for it.");
      }
      const sample = resolved.event ?? snapshot?.events.find((item) => item.seriesKey === resolved.seriesKey) ?? null;
      const leadTimes = args.leadTimes ? tidyLeadTimes(args.leadTimes) : null;
      const label = sample ? `every "${sample.title ?? "Untitled"}"` : "that recurring event";
      const summary = mode === "set" ? `Set ${label} to ring ${leadTimesText(leadTimes)}`
        : mode === "off" ? `Turned off alarms for ${label}` : `Reset ${label} to follow its calendar's settings`;
      const out = await applyChange(ctx, {
        recordIds: [resolved.seriesKey],
        tool: "set_series_alarms",
        summary,
        build: (current) => ({
          [resolved.seriesKey]: nextOverride(parseStored(current[resolved.seriesKey]), mode, leadTimes, currentLeadMinutes(sample)),
        }),
      });
      out.data.seriesKey = resolved.seriesKey;
      return out;
    },
  },
  {
    name: "set_calendar",
    title: "Change a calendar's alarms",
    description: "Changes one calendar on the phone: whether the app watches it (rings for its events), its default lead times, which invitations ring, and whether all-day events ring. Local-only calendars can't be changed here. Returns a changeId; then call confirm_change.",
    inputSchema: {
      calendar: z.string().min(1).max(300).describe("Calendar key, name, or Google calendarId."),
      watched: z.boolean().optional().describe("true to ring for this calendar's events, false to stop."),
      leadTimes: leadTimesInput.optional(),
      useAppDefaultLeadTimes: z.boolean().optional().describe("true to drop the calendar's own lead times and use the app default."),
      rsvpFilter: z.enum(["accepted_only", "accepted_or_tentative", "not_declined", "all_events"]).optional().describe("Which invitations ring."),
      includeAllDay: z.boolean().optional().describe("Whether all-day events ring."),
    },
    annotations: CHANGE,
    scope: "write",
    async handler(ctx, args) {
      const { watched, leadTimes, useAppDefaultLeadTimes, rsvpFilter, includeAllDay } = args;
      if ([watched, leadTimes, useAppDefaultLeadTimes, rsvpFilter, includeAllDay].every((value) => value === undefined)) {
        throw new ToolError("Say what to change: watched, leadTimes, useAppDefaultLeadTimes, rsvpFilter or includeAllDay.");
      }
      if (leadTimes && useAppDefaultLeadTimes) throw new ToolError("Use either leadTimes or useAppDefaultLeadTimes, not both.");
      const snapshot = await latestSnapshot(ctx);
      const { calendar, key } = resolveCalendar(snapshot, args.calendar, { accountEmails: await accountEmails(ctx) });
      const name = calendar?.name ? `"${calendar.name}"` : "that calendar";
      const parts = [];
      if (watched !== undefined) parts.push(watched ? "watched" : "not watched");
      if (leadTimes) parts.push(`ringing ${leadTimesText(tidyLeadTimes(leadTimes))}`);
      if (useAppDefaultLeadTimes) parts.push("using the app's default lead times");
      if (rsvpFilter) parts.push(`invitations: ${rsvpFilter.replace(/_/g, " ")}`);
      if (includeAllDay !== undefined) parts.push(includeAllDay ? "all-day events ring" : "all-day events skipped");
      return applyChange(ctx, {
        recordIds: [key],
        tool: "set_calendar",
        summary: `Set ${name}: ${parts.join(", ")}`,
        build: (current) => {
          const stored = parseStored(current[key]) ?? {};
          const overrides = { ...(stored.overrides ?? {}) };
          if (leadTimes) overrides.leadTimes = tidyLeadTimes(leadTimes);
          if (useAppDefaultLeadTimes) delete overrides.leadTimes;
          if (rsvpFilter) overrides.rsvpFilter = rsvpFilter;
          if (includeAllDay !== undefined) overrides.ignoreAllDay = !includeAllDay;
          const meaningful = Object.values(overrides).some((value) => value !== null && value !== undefined);
          return { [key]: { selected: watched ?? stored.selected ?? null, overrides: meaningful ? overrides : null } };
        },
      });
    },
  },
  {
    name: "update_settings",
    title: "Change app settings",
    description: "Changes app-wide alarm, snooze, spoken-alarm and appearance settings. Only include the settings to change; null resets one to the app default. Pausing alarms has its own tools. Returns a changeId; then call confirm_change.",
    inputSchema: {
      settings: z.object(Object.fromEntries(Object.entries(SETTINGS).map(([field, setting]) => [field, setting.schema.nullable().optional()])))
        .strict().describe("Settings to change."),
    },
    annotations: CHANGE,
    scope: "write",
    async handler(ctx, args) {
      const entries = Object.entries(args.settings ?? {}).filter(([, value]) => value !== undefined);
      if (!entries.length) throw new ToolError("Include at least one setting to change.");
      const next = {};
      const parts = [];
      for (const [field, value] of entries) {
        const setting = SETTINGS[field];
        next[`p_${setting.record}`] = value === null ? null : setting.encode ? setting.encode(value) : value;
        parts.push(`${setting.label.replace(/ \(.*\)$/, "").toLowerCase()} ${value === null ? "reset to default" : Array.isArray(value) ? leadTimesText(tidyLeadTimes(value)) : value}`);
      }
      return applyChange(ctx, {
        recordIds: Object.keys(next),
        tool: "update_settings",
        summary: `Changed settings: ${parts.join(", ")}`,
        build: () => next,
      });
    },
  },
  {
    name: "pause_alarms",
    title: "Pause alarms",
    description: "Pauses every Always On Time alarm on the user's phones until a time, or until resumed. Returns a changeId; then call confirm_change.",
    inputSchema: {
      until: z.string().max(40).optional().describe("When alarms start ringing again, ISO 8601 (phone's time zone if no offset). Omit with indefinitely=true."),
      indefinitely: z.boolean().optional().describe("true to pause until the user resumes."),
    },
    annotations: CHANGE,
    scope: "write",
    async handler(ctx, args) {
      const devices = await readDevices(ctx.db, ctx.uid);
      if (!devices.length) return noPhone(ctx);
      if (!devices.some((device) => Array.isArray(device.capabilities) && device.capabilities.includes("pause"))) {
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
        if (until - ctx.now() > 366 * DAY_MS) throw new ToolError("Alarms can be paused for at most a year; use indefinitely instead.");
      }
      return applyChange(ctx, {
        recordIds: [`p_${PAUSED_UNTIL}`],
        tool: "pause_alarms",
        summary: until === -1 ? "Paused alarms until resumed" : `Paused alarms until ${formatTime(until, timeZone)}`,
        build: () => ({ [`p_${PAUSED_UNTIL}`]: until }),
      });
    },
  },
  {
    name: "resume_alarms",
    title: "Resume alarms",
    description: "Ends a pause so alarms ring again. Returns a changeId; then call confirm_change.",
    inputSchema: {},
    annotations: CHANGE,
    scope: "write",
    async handler(ctx) {
      return applyChange(ctx, {
        recordIds: [`p_${PAUSED_UNTIL}`],
        tool: "resume_alarms",
        summary: "Resumed alarms",
        build: () => ({ [`p_${PAUSED_UNTIL}`]: 0 }),
      });
    },
  },
  {
    name: "undo",
    title: "Undo a change",
    description: "Reverses an earlier change (by its changeId) made through any assistant in the last 30 days, unless those settings have changed again since. Returns a new changeId; then call confirm_change.",
    inputSchema: { changeId: z.string().regex(/^ch_[A-Za-z0-9_-]{16}$/).describe("The changeId the change returned.") },
    annotations: { ...CHANGE, idempotentHint: false },
    scope: "write",
    async handler(ctx, args) {
      const activityRef = refs.activity(ctx.db, ctx.uid).doc(args.changeId);
      const activity = await activityRef.get();
      if (!activity.exists) throw new ToolError("No change with that changeId in the last 30 days.");
      const original = activity.data();
      const recordIds = Object.keys(original.records ?? {}).filter(isRecordId);
      if (!recordIds.length) throw new ToolError("That change has nothing to undo.");
      const out = await applyChange(ctx, {
        recordIds,
        tool: "undo",
        summary: `Undid: ${original.summary}`,
        build: async (current, read) => {
          const fresh = await read(activityRef);
          if (!fresh.exists) throw new ToolError("No change with that changeId in the last 30 days.");
          if (fresh.data().undoneAt) throw new ToolError("That change was already undone.");
          const changed = recordIds.filter((id) => current[id] !== original.records[id].after);
          if (changed.length) throw new ToolError("Those settings have changed again since, so undo would overwrite newer changes. Make the change you want directly instead.");
          return Object.fromEntries(recordIds.map((id) => {
            const before = original.records[id].before;
            if (before !== null && before !== undefined) return [id, new RawPayload(before)];
            // The record didn't exist before: write the value that means "not set".
            return [id, id.startsWith("c_") ? { selected: null, overrides: null } : null];
          }));
        },
        // Guarded like the values, so two concurrent undos cannot both succeed.
        afterWrite: (batch, snapshotOf) => batch.update(activityRef, { undoneAt: new Date(ctx.now()) }, { lastUpdateTime: snapshotOf(activityRef).updateTime }),
      });
      if (out.data.changed) ctx.count("undos");
      return out;
    },
  },
  {
    name: "confirm_change",
    title: "Confirm a change reached the phone",
    description: "Waits up to waitSeconds for the user's phones to apply a change, then reports which did. Call it after every change before telling the user the alarm is set on their phone.",
    inputSchema: {
      changeId: z.string().regex(/^ch_[A-Za-z0-9_-]{16}$/).describe("The changeId a change returned."),
      waitSeconds: z.number().int().min(0).max(15).optional().describe("How long to wait (default 10, at most 15)."),
    },
    annotations: READ,
    scope: "read",
    waits: true,
    async handler(ctx, args) {
      const activity = await refs.activity(ctx.db, ctx.uid).doc(args.changeId).get();
      if (!activity.exists) throw new ToolError("No change with that changeId in the last 30 days.");
      const writtenAt = await changeWriteTime(ctx, activity.data());
      const deadline = ctx.now() + (args.waitSeconds ?? 10) * 1000;
      let snapshots = [];
      await sleepUntil(ctx, deadline, async () => {
        snapshots = await loadSnapshots(ctx);
        return snapshots.length > 0 && snapshots.every((snapshot) => snapshot.valuesAppliedThrough >= writtenAt);
      });
      const applied = snapshots.filter((snapshot) => snapshot.valuesAppliedThrough >= writtenAt);
      const waiting = snapshots.filter((snapshot) => snapshot.valuesAppliedThrough < writtenAt);
      const outcome = !snapshots.length || !applied.length ? "pending" : waiting.length ? "partial" : "confirmed";
      ctx.count(`confirms.${outcome}`);
      let text;
      if (outcome === "confirmed") text = `Confirmed on ${applied.map((snapshot) => snapshot.device).join(", ")}.`;
      else if (outcome === "partial") text = `Confirmed on ${applied.map((s) => s.device).join(", ")}; ${waiting.map((s) => s.device).join(", ")} will apply it when it's online.`;
      else text = "Saved; the phone will apply it when it's online (opening Always On Time syncs it right away).";
      return result(text, {
        outcome,
        appliedOn: applied.map((snapshot) => snapshot.device),
        waitingOn: waiting.map((snapshot) => snapshot.device),
      });
    },
  },
  {
    name: "test_connection",
    title: "Test the connection to the phone",
    description: "Setup check: sends a test message to each connected phone (it shows a \"connected\" notification) and reports which received it. Run it the first time a connection is used, when get_status says setup isn't confirmed, or when changes don't seem to reach the phone.",
    inputSchema: { waitSeconds: z.number().int().min(1).max(20).optional().describe("How long to wait for phones to answer (default 15, at most 20).") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    scope: "read",
    waits: true,
    async handler(ctx, args) {
      const devices = await readDevices(ctx.db, ctx.uid);
      if (!devices.length) {
        ctx.count("setupTests.noDevices");
        const link = appLink(ctx.origin, "assistants");
        return result(`Open Always On Time on your phone to finish connecting (signed in with the same Google account), then run this test again. Link: ${link}`, {
          outcome: "noDevices", links: { assistants: link },
        });
      }
      const pingId = `ping_${randomBytes(12).toString("base64url")}`;
      const sent = await push(ctx, "ping", { pingId, assistant: String(ctx.grant.clientName).slice(0, 60) }, devices);
      if (sent.limited) throw new ToolError("Too many messages to the phone recently; wait a few minutes and try again.");
      const reachable = sent.sent;
      const deadline = ctx.now() + (args.waitSeconds ?? 15) * 1000;
      let received = [];
      if (reachable.length) {
        await sleepUntil(ctx, deadline, async () => {
          const current = await readDevices(ctx.db, ctx.uid);
          received = current.filter((device) => device.lastPing?.id === pingId);
          return received.length === reachable.length;
        });
      }
      const missing = devices.filter((device) => !received.some((item) => item.id === device.id));
      const lines = [];
      if (received.length) lines.push(`Message received on ${names(received)}.`);
      const permissions = appLink(ctx.origin, "permissions");
      const battery = appLink(ctx.origin, "battery");
      const silent = missing.filter((device) => device.fcmToken);
      if (silent.length) lines.push(`${names(silent)} didn't answer. Ask the user to open Always On Time, and check its notification and battery settings: ${permissions} and ${battery}`);
      const noToken = missing.filter((device) => !device.fcmToken);
      if (noToken.length) lines.push(`${names(noToken)} can't receive messages from the assistant yet; changes reach it on its next sync.`);
      const outcome = received.length ? (missing.length ? "partial" : "received") : silent.length ? "noAnswer" : "unreachable";
      ctx.count(`setupTests.${outcome}`);
      if (received.length && !ctx.grant.setupConfirmedAt) {
        await ctx.confirmSetup();
        lines.push("Setup is confirmed.");
      }
      return result(lines.join("\n"), {
        outcome,
        received: received.map(deviceName),
        noAnswer: silent.map(deviceName),
        cannotReceive: noToken.map(deviceName),
        links: missing.length ? { permissions, battery } : {},
      });
    },
  },
  {
    name: "refresh",
    title: "Refresh from the phone",
    description: "Asks the phones to share their alarms now and waits for a fresh copy; returns it, or the last one with its time. Use it when the snapshot looks old or right after the user changed something in the app.",
    inputSchema: { waitSeconds: z.number().int().min(1).max(15).optional().describe("How long to wait (default 10, at most 15).") },
    annotations: READ,
    scope: "read",
    waits: true,
    async handler(ctx, args) {
      const devices = await readDevices(ctx.db, ctx.uid);
      if (!devices.length) return noPhone(ctx);
      const requestId = `req_${randomBytes(12).toString("base64url")}`;
      const sent = await push(ctx, "publish", { requestId }, devices);
      if (sent.limited) throw new ToolError("Too many messages to the phone recently; wait a few minutes and try again.");
      const deadline = ctx.now() + (args.waitSeconds ?? 10) * 1000;
      let snapshots = [];
      const fresh = sent.sent.length ? await sleepUntil(ctx, deadline, async () => {
        snapshots = await loadSnapshots(ctx);
        return snapshots.find((snapshot) => snapshot.requestId === requestId) ?? null;
      }) : null;
      if (!snapshots.length) snapshots = await loadSnapshots(ctx);
      const snapshot = fresh ?? snapshots[0];
      if (!snapshot) return noPhone(ctx);
      const alarms = snapshot.events.reduce((total, event) => total + event.alarms.filter((alarm) => alarm.status === "on").length, 0);
      const summary = `${snapshot.events.length} events with ${alarms} upcoming alarms on ${snapshot.calendars.filter((c) => c.watched).length} watched calendars.`;
      const text = fresh
        ? `Fresh from ${snapshot.device}: ${summary}`
        : `${snapshot.device} didn't answer in time; the last copy is ${relativeAge(snapshot.publishedAt, ctx.now())} old. ${basis(snapshot, ctx.now())} ${summary}`;
      return result(text, {
        fresh: Boolean(fresh),
        basedOn: { device: snapshot.device, publishedAt: isoLocal(snapshot.publishedAt, snapshot.timeZone) },
        events: snapshot.events.length,
        alarms,
      });
    },
  },
  {
    name: "open_in_app",
    title: "Link to a screen in the app",
    description: "Returns a link that opens a screen of Always On Time on the user's phone: an event, calendars, settings, permissions, battery guidance, travel, account, connected assistants, or Plus. Use it for anything that has to be done on the phone (sounds, voices, permissions) and when the user wants Plus. Links only open screens; they never change anything.",
    inputSchema: {
      destination: z.enum(["event", "calendars", "calendar", "settings/alarms", "settings/sounds", "settings/spoken", "permissions", "battery", "travel", "account", "assistants", "plus"]),
      key: z.string().max(80).optional().describe("Event key for \"event\", calendar key for \"calendar\" (short forms work)."),
    },
    annotations: READ,
    scope: "read",
    async handler(ctx, args) {
      let key = args.key;
      if (args.destination === "event" || args.destination === "calendar") {
        if (!key) throw new ToolError(`${args.destination} links need a key.`);
        const snapshot = await latestSnapshot(ctx);
        key = args.destination === "event"
          ? resolveEvent(snapshot, { event: key }).eventKey
          : resolveCalendar(snapshot, key).key;
      }
      const link = appLink(ctx.origin, args.destination, key);
      let text = `Open in Always On Time: ${link}`;
      if (args.destination === "plus") {
        ctx.count("plusGate");
        text = `Live traffic updates are part of Always On Time Plus, which the user can get in the app (the assistant can't turn it on): ${link}`;
      }
      return result(text, { link });
    },
  },
];

module.exports = { INSTRUCTIONS, SETTINGS, TOOLS, nextOverride, noPhone };

"use strict";

// Reading the phone's published snapshot for the assistant tools: times in the phone's time zone,
// event and calendar lookup (by key, short key, name, or Google Calendar ids), and App Links.
//
// Titles, calendar names and device labels are third-party text (anyone can send an invitation),
// so normalizeSnapshot cleans them before any tool shows them, and text output quotes titles.

const {
  RecordError, googleCalendarCandidates, googleEventKeys, isCalendarKey, isEventKey, isSeriesKey,
} = require("./assistant-records");

const SHORT_KEY_HEX = 12;
const MIN_PREFIX_HEX = 8;

class ToolError extends Error {
  /** A problem the assistant should relay or fix; `data` adds structured next steps. */
  constructor(message, data = {}) {
    super(message);
    this.data = data;
  }
}

// ---- Third-party text ------------------------------------------------------------------------------

const MAX_TEXT = 200;
// Format characters (bidi controls, zero-width characters) are removed; control characters and
// line or paragraph separators become spaces.
const FORMAT_CHARS = /\p{Cf}/gu;
const BREAKING_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

/** One line of plain text: no control, format or bidi characters, collapsed whitespace, at most `max` characters. */
function cleanText(value, max = MAX_TEXT) {
  if (typeof value !== "string") return "";
  const text = value.replace(FORMAT_CHARS, "").replace(BREAKING_CHARS, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() : text;
}

/** A title as it appears in tool text: JSON-quoted, so it reads as data, never as part of the sentence. */
const quoted = (text) => JSON.stringify(text || "Untitled");

// ---- Time --------------------------------------------------------------------------------------

function validTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** Offset of `timeZone` from UTC at `ms`, in minutes. */
function offsetMinutes(ms, timeZone) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(new Date(ms)).find((item) => item.type === "timeZoneName")?.value ?? "GMT";
  const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(part);
  if (!match) return 0;
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

/** "2026-10-20T15:00:00-07:00" in the phone's zone. */
function isoLocal(ms, timeZone) {
  const offset = offsetMinutes(ms, timeZone);
  const local = new Date(ms + offset * 60_000).toISOString().slice(0, 19);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** "Tue, Oct 20, 3:00 PM" (date omitted with `timeOnly`). */
function formatTime(ms, timeZone, { timeOnly = false } = {}) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    ...(timeOnly ? {} : { weekday: "short", month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

const formatDay = (ms, timeZone) => new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(new Date(ms));

/**
 * Parses an assistant-supplied time. ISO times with an offset are absolute; "2026-10-20" and
 * "2026-10-20T09:00" are read in the phone's time zone.
 */
function parseTime(text, timeZone, name = "time") {
  if (typeof text !== "string") throw new ToolError(`${name} must be an ISO 8601 date or time`);
  const trimmed = text.trim();
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed) && /T/.test(trimmed)) {
    const ms = Date.parse(trimmed);
    if (Number.isFinite(ms)) return ms;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(trimmed);
  if (!match) throw new ToolError(`${name} must be an ISO 8601 date or time, e.g. 2026-10-20 or 2026-10-20T09:00`);
  const [year, month, day, hour = 0, minute = 0, second = 0] = match.slice(1).map((part) => (part === undefined ? undefined : Number(part)));
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  // Two passes settle the offset across daylight-saving changes.
  let ms = wall - offsetMinutes(wall, timeZone) * 60_000;
  ms = wall - offsetMinutes(ms, timeZone) * 60_000;
  return ms;
}

function relativeAge(ms, now) {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const minutesLabel = (minutes) => {
  if (minutes === 0) return "at start";
  const abs = Math.abs(minutes);
  const text = abs % 1440 === 0 ? `${abs / 1440} day${abs === 1440 ? "" : "s"}` : abs % 60 === 0 ? `${abs / 60} h` : `${abs} min`;
  return minutes > 0 ? `${text} before` : `${text} after start`;
};

// ---- Links ---------------------------------------------------------------------------------------

const DESTINATIONS = [
  "event", "calendars", "calendar", "settings/alarms", "settings/sounds", "settings/spoken",
  "permissions", "battery", "travel", "account", "assistants", "plus",
];

/** App Link for a destination. Links only open screens and never contain titles. */
function appLink(origin, destination, key) {
  if (destination === "event") {
    if (!isEventKey(key)) throw new ToolError("event links need a full event key (e_...)");
    return `${origin}/open/event/${key}`;
  }
  if (destination === "calendar") {
    if (!isCalendarKey(key)) throw new ToolError("calendar links need a full calendar key (c_...)");
    return `${origin}/open/calendar/${key}`;
  }
  if (destination === "plus") return `${origin}/open/plus?source=assistant`;
  if (!DESTINATIONS.includes(destination)) throw new ToolError(`unknown destination ${destination}`);
  return `${origin}/open/${destination}`;
}

// ---- Snapshot ------------------------------------------------------------------------------------

const shortKey = (key) => (typeof key === "string" ? key.slice(0, 2 + SHORT_KEY_HEX) : null);

// The snapshot vocabulary (docs/ASSISTANT_PROTOCOL.md "Snapshot"); anything else becomes null.
const ALARM_KINDS = ["lead", "travel"];
const ALARM_SOURCES = ["app", "calendar", "series", "event", "travel"];
const ALARM_STATUSES = ["on", "off", "paused", "past"];
const RSVP_VALUES = ["ACCEPTED", "TENTATIVE", "DECLINED", "INVITED", "NONE", "ORGANIZER"];
const RSVP_FILTERS = ["accepted_only", "accepted_or_tentative", "not_declined", "all_events"];
const STALE_MS = 6 * 60 * 60 * 1000;

const oneOf = (values, value) => (values.includes(value) ? value : null);
const keyOr = (test, value) => (test(value) ? value : null);
const finite = (value) => (Number.isFinite(value) ? value : null);
const intList = (value) => (Array.isArray(value) ? value.filter(Number.isInteger) : null);
const optionalBool = (value) => (typeof value === "boolean" ? value : null);

function normalizeAlarm(alarm) {
  return {
    at: alarm.at,
    kind: oneOf(ALARM_KINDS, alarm.kind) ?? "lead",
    minutes: Number.isInteger(alarm.minutes) ? alarm.minutes : 0,
    source: oneOf(ALARM_SOURCES, alarm.source),
    status: oneOf(ALARM_STATUSES, alarm.status) ?? "on",
  };
}

function normalizeEvent(event) {
  return {
    eventKey: keyOr(isEventKey, event.eventKey),
    seriesKey: keyOr(isSeriesKey, event.seriesKey),
    calendarKey: keyOr(isCalendarKey, event.calendarKey),
    title: cleanText(event.title),
    start: event.start,
    end: finite(event.end),
    allDay: Boolean(event.allDay),
    recurring: Boolean(event.recurring),
    rsvp: oneOf(RSVP_VALUES, event.rsvp),
    alarms: (Array.isArray(event.alarms) ? event.alarms : []).filter((alarm) => alarm && Number.isFinite(alarm.at)).map(normalizeAlarm),
  };
}

function normalizeCalendar(calendar) {
  // Phones send the storage value (not_declined); older builds sent the enum name (NOT_DECLINED).
  const rsvpFilter = typeof calendar.rsvpFilter === "string" ? oneOf(RSVP_FILTERS, calendar.rsvpFilter.toLowerCase()) : null;
  return {
    key: keyOr(isCalendarKey, calendar.key),
    name: cleanText(calendar.name),
    accountType: cleanText(calendar.accountType, 100) || null,
    watched: Boolean(calendar.watched),
    leadTimes: intList(calendar.leadTimes),
    enabled: optionalBool(calendar.enabled),
    rsvpFilter,
    includeAllDay: optionalBool(calendar.includeAllDay),
  };
}

/**
 * Normalizes a snapshot payload so tools can rely on its shape and only ever see clean text.
 * `builtAt` is when the phone built it (older phones don't send it; then the publish time).
 */
function normalizeSnapshot(snapshot) {
  const payload = snapshot.payload ?? {};
  const timeZone = validTimeZone(typeof payload.timeZone === "string" ? payload.timeZone : "UTC");
  const calendars = (Array.isArray(payload.calendars) ? payload.calendars : []).filter((item) => item && typeof item === "object").map(normalizeCalendar);
  const events = (Array.isArray(payload.events) ? payload.events : [])
    .filter((item) => item && typeof item === "object" && Number.isFinite(item.start))
    .map(normalizeEvent)
    .sort((a, b) => a.start - b.start);
  const builtAt = Number.isFinite(payload.builtAt) ? Math.min(payload.builtAt, snapshot.publishedAt) : snapshot.publishedAt;
  const pausedUntil = payload.paused && typeof payload.paused === "object" && Number.isSafeInteger(payload.paused.until) ? payload.paused.until : 0;
  return {
    deviceId: snapshot.deviceId,
    device: cleanText(payload.device, 100) || "your phone",
    publishedAt: snapshot.publishedAt,
    builtAt,
    requestId: snapshot.requestId,
    timeZone,
    valuesAppliedThrough: Number.isFinite(payload.valuesAppliedThrough) ? payload.valuesAppliedThrough : 0,
    windowEnd: finite(payload.windowEnd),
    paused: { until: pausedUntil },
    calendars,
    events,
  };
}

/** "As of 2:04 PM from Pixel 9" (with the date when it is not today), from when the phone built it. */
function basis(snapshot, now) {
  const sameDay = formatDay(snapshot.builtAt, snapshot.timeZone) === formatDay(now, snapshot.timeZone);
  const when = formatTime(snapshot.builtAt, snapshot.timeZone, { timeOnly: sameDay });
  const stale = now - snapshot.builtAt > STALE_MS ? ` (${relativeAge(snapshot.builtAt, now)}; call refresh for a newer copy)` : "";
  return `As of ${when} from ${snapshot.device}${stale}.`;
}

/** Where a tool's answer came from, for structured content. */
const basedOn = (snapshot) => ({
  device: snapshot.device,
  builtAt: isoLocal(snapshot.builtAt, snapshot.timeZone),
  publishedAt: isoLocal(snapshot.publishedAt, snapshot.timeZone),
});

function calendarName(snapshot, key) {
  return snapshot.calendars.find((calendar) => calendar.key && calendar.key === key)?.name || null;
}

/** Finds snapshot entries whose key equals `ref` or starts with it (≥ 8 hex characters, unique). */
function matchKey(items, field, ref, prefix) {
  if (typeof ref !== "string" || !ref.startsWith(prefix)) return { matches: [] };
  const hex = ref.slice(2).toLowerCase();
  if (!/^[a-f0-9]+$/.test(hex) || hex.length < MIN_PREFIX_HEX) return { matches: [] };
  const full = `${prefix}${hex}`;
  const matches = items.filter((item) => typeof item[field] === "string" && item[field].startsWith(full));
  const keys = [...new Set(matches.map((item) => item[field]))];
  return { matches, keys };
}

/**
 * Resolves a calendar reference: a key (full or short), the calendar's name, or a Google calendarId.
 * Returns the snapshot calendar (or null when there is no snapshot) and its key.
 */
function resolveCalendar(snapshot, ref, { accountEmails = [] } = {}) {
  if (typeof ref !== "string" || ref.trim() === "") throw new ToolError("calendar is required");
  const text = ref.trim();
  const calendars = snapshot?.calendars ?? [];
  if (/^c_[a-f0-9]+$/i.test(text)) {
    const { keys } = matchKey(calendars, "key", text, "c_");
    if (keys?.length === 1) return { calendar: calendars.find((item) => item.key === keys[0]), key: keys[0] };
    if (isCalendarKey(text)) return { calendar: null, key: text };
    throw new ToolError("No calendar on the phone has that key. Call list_calendars to see them.");
  }
  const byName = calendars.filter((item) => typeof item.name === "string" && item.name.toLowerCase() === text.toLowerCase());
  if (byName.length === 1) {
    if (!byName[0].key) throw localOnly(byName[0]);
    return { calendar: byName[0], key: byName[0].key };
  }
  if (byName.length > 1) throw new ToolError(`More than one calendar is named ${quoted(text)}. Use its key from list_calendars.`);
  if (text.includes("@")) {
    const candidates = googleCalendarCandidates(text, accountEmails);
    const found = candidates.find((candidate) => calendars.some((item) => item.key === candidate.key));
    if (found) return { calendar: calendars.find((item) => item.key === found.key), key: found.key };
    if (!snapshot && candidates.length) return { calendar: null, key: candidates[0].key };
    throw new ToolError("That Google calendar isn't on the phone. The phone may sync it under another account, or not at all; call list_calendars to see what the phone has.");
  }
  throw new ToolError(`No calendar named ${quoted(cleanText(text))} on the phone. Call list_calendars to see them.`);
}

function localOnly(calendar) {
  return new ToolError(`${quoted(calendar.name)} is a local calendar on the phone without a portable identity, so it can only be changed in the app.`);
}

/** Inputs that can name an event or series. */
function hasGoogleIds(args) {
  return typeof args.googleCalendarId === "string" && typeof args.googleEventId === "string";
}

/**
 * Resolves the event the assistant means, from an event key (full or short) or Google Calendar ids.
 * Returns {eventKey, seriesKey, calendarKey, event (snapshot entry or null), recurring}.
 */
function resolveEvent(snapshot, args, { accountEmails = [], needOccurrence = true } = {}) {
  const events = snapshot?.events ?? [];
  if (typeof args.event === "string" && args.event.trim()) {
    const ref = args.event.trim();
    if (ref.startsWith("s_")) {
      if (needOccurrence) throw new ToolError("That is a series key; use an event key (e_...) for one occurrence.");
      const { keys } = matchKey(events, "seriesKey", ref, "s_");
      const key = keys?.length === 1 ? keys[0] : isSeriesKey(ref) ? ref : null;
      if (!key) throw new ToolError("No upcoming event belongs to that series key. Use find_events to look it up.");
      const event = events.find((item) => item.seriesKey === key) ?? null;
      return { eventKey: null, seriesKey: key, calendarKey: event?.calendarKey ?? null, event, recurring: true };
    }
    const { keys } = matchKey(events, "eventKey", ref, "e_");
    if (keys?.length > 1) throw new ToolError("That short key matches more than one event; use the full key.");
    if (keys?.length === 1) {
      const event = events.find((item) => item.eventKey === keys[0]);
      return { eventKey: event.eventKey, seriesKey: event.seriesKey ?? null, calendarKey: event.calendarKey ?? null, event, recurring: Boolean(event.recurring) };
    }
    if (isEventKey(ref)) return { eventKey: ref, seriesKey: null, calendarKey: null, event: null, recurring: null };
    throw new ToolError("No event in the next 30 days on watched calendars has that key. Use find_events to look it up.");
  }
  if (!hasGoogleIds(args)) {
    throw new ToolError("Name the event with its key from find_events or list_upcoming_alarms (event), or with googleCalendarId and googleEventId from the calendar connector.");
  }
  const { key: calendarKey } = resolveCalendar(snapshot, args.googleCalendarId, { accountEmails });
  let keys;
  try {
    keys = googleEventKeys(calendarKey, {
      eventId: args.googleEventId,
      recurringEventId: args.recurringEventId,
      originalStartTime: args.originalStartTime,
    });
  } catch (error) {
    if (error instanceof RecordError) throw new ToolError(error.message);
    throw error;
  }
  const bySeries = events.filter((item) => item.seriesKey === keys.seriesKey);
  const exact = keys.eventKey ? events.find((item) => item.eventKey === keys.eventKey) : null;
  if (exact) return { ...keys, calendarKey, event: exact, recurring: Boolean(exact.recurring) };
  const recurring = keys.recurring ?? (bySeries.length ? bySeries.some((item) => item.recurring) : null);
  if (needOccurrence && (recurring === true) && (keys.recurring !== true || keys.eventKey === null || keys.originalStartMillis === null)) {
    throw new ToolError("That is a recurring event. Pass the occurrence's instance id (as googleEventId) or its originalStartTime to change one occurrence, or use set_series_alarms for every occurrence.");
  }
  return { ...keys, calendarKey, event: bySeries[0] && !needOccurrence ? bySeries[0] : null, recurring };
}

/** Case-insensitive title search: every word of the query must appear. */
function searchEvents(events, query) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return events;
  return events.filter((event) => {
    const title = String(event.title ?? "").toLowerCase();
    return words.every((word) => title.includes(word));
  });
}

module.exports = {
  ALARM_KINDS,
  ALARM_SOURCES,
  ALARM_STATUSES,
  DESTINATIONS,
  RSVP_VALUES,
  ToolError,
  appLink,
  basedOn,
  basis,
  calendarName,
  cleanText,
  formatDay,
  formatTime,
  isoLocal,
  minutesLabel,
  normalizeSnapshot,
  offsetMinutes,
  parseTime,
  quoted,
  relativeAge,
  resolveCalendar,
  resolveEvent,
  searchEvents,
  shortKey,
  validTimeZone,
};

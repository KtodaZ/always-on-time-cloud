"use strict";

// Reading the phone's published snapshot for the assistant tools: times in the phone's time zone,
// event and calendar lookup (by key, short key, name, or Google Calendar ids), and App Links.

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

/** Normalizes a snapshot payload so tools can rely on its shape. */
function normalizeSnapshot(snapshot) {
  const payload = snapshot.payload ?? {};
  const timeZone = validTimeZone(typeof payload.timeZone === "string" ? payload.timeZone : "UTC");
  const calendars = (Array.isArray(payload.calendars) ? payload.calendars : []).filter((item) => item && typeof item === "object");
  const events = (Array.isArray(payload.events) ? payload.events : [])
    .filter((item) => item && typeof item === "object" && Number.isFinite(item.start))
    .map((event) => ({ ...event, alarms: (Array.isArray(event.alarms) ? event.alarms : []).filter((alarm) => alarm && Number.isFinite(alarm.at)) }))
    .sort((a, b) => a.start - b.start);
  return {
    deviceId: snapshot.deviceId,
    device: typeof payload.device === "string" && payload.device ? payload.device.slice(0, 100) : "your phone",
    publishedAt: snapshot.publishedAt,
    requestId: snapshot.requestId,
    timeZone,
    valuesAppliedThrough: Number.isFinite(payload.valuesAppliedThrough) ? payload.valuesAppliedThrough : 0,
    windowEnd: Number.isFinite(payload.windowEnd) ? payload.windowEnd : null,
    paused: payload.paused && typeof payload.paused === "object" ? payload.paused : { until: 0 },
    calendars,
    events,
  };
}

/** "As of 2:04 PM from Pixel 9" (with the date when it is not today). */
function basis(snapshot, now) {
  const sameDay = formatDay(snapshot.publishedAt, snapshot.timeZone) === formatDay(now, snapshot.timeZone);
  const when = formatTime(snapshot.publishedAt, snapshot.timeZone, { timeOnly: sameDay });
  const stale = now - snapshot.publishedAt > 6 * 60 * 60 * 1000 ? ` (${relativeAge(snapshot.publishedAt, now)}; call refresh for a newer copy)` : "";
  return `As of ${when} from ${snapshot.device}${stale}.`;
}

function calendarName(snapshot, key) {
  return snapshot.calendars.find((calendar) => calendar.key && calendar.key === key)?.name ?? null;
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
  if (byName.length > 1) throw new ToolError(`More than one calendar is named "${text}". Use its key from list_calendars.`);
  if (text.includes("@") || text.endsWith("calendar.google.com")) {
    const candidates = googleCalendarCandidates(text, accountEmails);
    const found = candidates.find((candidate) => calendars.some((item) => item.key === candidate.key));
    if (found) return { calendar: calendars.find((item) => item.key === found.key), key: found.key };
    if (!snapshot && candidates.length) return { calendar: null, key: candidates[0].key };
    throw new ToolError("That Google calendar isn't on the phone. The phone may sync it under another account, or not at all; call list_calendars to see what the phone has.");
  }
  throw new ToolError(`No calendar named "${text}" on the phone. Call list_calendars to see them.`);
}

function localOnly(calendar) {
  return new ToolError(`"${calendar.name}" is a local calendar on the phone without a portable identity, so it can only be changed in the app.`);
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
  DESTINATIONS,
  ToolError,
  appLink,
  basis,
  calendarName,
  formatDay,
  formatTime,
  isoLocal,
  minutesLabel,
  normalizeSnapshot,
  offsetMinutes,
  parseTime,
  relativeAge,
  resolveCalendar,
  resolveEvent,
  searchEvents,
  shortKey,
  validTimeZone,
};

"use strict";

// Account record keys and payload validation for the assistant connector, matching the phone app
// (docs/ASSISTANT_PROTOCOL.md "Record keys and payloads"). The server checks every payload against
// the same limits the app enforces before it writes anything to accounts/{uid}/values.

const { createHash } = require("node:crypto");

const MAX_PAYLOAD_CHARS = 16384;
const LEAD_TIME_MIN = -1440;
const LEAD_TIME_MAX = 10080;
const MAX_LEAD_TIMES = 20;
// The app's travel picker: at most four alarms (LeadTimeCodec.MAX_ALARMS_PER_EVENT), each up to
// 2 h 59 min before leaving (TravelLeadTimes.MAX_MINUTES).
const MAX_TRAVEL_LEAD_TIMES = 4;
const TRAVEL_LEAD_TIME_MAX = 179;

const RECORD_ID = /^(p_[a-z_]+|[cse]_[a-f0-9]{64})$/;
const KEY = { c: /^c_[a-f0-9]{64}$/, s: /^s_[a-f0-9]{64}$/, e: /^e_[a-f0-9]{64}$/ };

// The app's synced preferences (PortablePreferences.kt), mirrored in
// docs/assistant-protocol-vectors.json "preferences" (a test keeps the two equal).
const PREFERENCE_BOOLEANS = new Set([
  "dynamic_color", "apply_accent_to_app", "vibration_enabled", "gradual_volume_enabled",
  "spoken_alarm_include_event_name", "spoken_alarm_include_time_until_event",
  "spoken_alarm_include_location", "spoken_alarm_include_helpful_reminder",
  "respect_dnd", "override_dnd_for_priority", "ignore_all_day_events",
  "auto_detect_meeting_urls", "override_system_volume", "smart_snooze_suggestions",
]);
const PREFERENCE_INTEGERS = new Map([
  ["default_lead_time_minutes", [0, 10080]],
  ["alarm_volume", [0, 100]],
  ["snooze_duration_minutes", [1, 1440]],
  ["alarm_duration_seconds", [0, 86400]],
  ["max_snoozes", [0, 100]],
  ["spoken_alarm_speech_rate_hundredths", [25, 400]],
]);
const PREFERENCE_STRING_MAX = 500;
// Allowed values are the app's storage values (null: any text up to 500 characters). Accents and
// vibration patterns are open lists the app may grow. "once" and "automatic" are repetition
// values older releases stored and the app still reads.
const PREFERENCE_STRINGS = new Map([
  ["theme_preference", ["system", "light", "dark"]],
  ["accent_id", null],
  ["default_lead_times_csv", null],
  ["alert_type", ["sound_and_vibration", "vibration_only", "visual_only"]],
  ["vibration_pattern", null],
  ["spoken_alarm_meeting_type_preference", ["enabled", "disabled"]],
  ["spoken_alarm_repetition", ["never", "after_15_seconds", "after_30_seconds", "after_1_minute", "after_2_minutes", "once", "automatic"]],
  ["rsvp_filter", ["accepted_only", "accepted_or_tentative", "not_declined", "all_events"]],
]);
const PAUSED_UNTIL = "alarms_paused_until";
// 0 = not paused, -1 = until resumed, otherwise epoch ms up to 2100-01-01 (PortablePreferences.LATEST_EPOCH_MILLIS).
const PAUSED_UNTIL_MAX = 4102444800000;
const PREFERENCE_LONGS = new Map([[PAUSED_UNTIL, [-1, PAUSED_UNTIL_MAX]]]);
const PREFERENCE_NAMES = new Set([
  ...PREFERENCE_BOOLEANS, ...PREFERENCE_INTEGERS.keys(), ...PREFERENCE_STRINGS.keys(), ...PREFERENCE_LONGS.keys(),
]);

class RecordError extends Error {}

const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * `json(list)` in the protocol is kotlinx `Json.encodeToString(listOf(...))`: a compact array with
 * only JSON's required escapes, which is what JSON.stringify produces for ordinary strings.
 */
const compactJson = (list) => JSON.stringify(list);

function requireText(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new RecordError(`${name} is required`);
  return value;
}

function calendarKey(accountType, accountName, calendarName) {
  return `c_${sha256Hex(compactJson([
    requireText(accountType, "accountType"), requireText(accountName, "accountName"), requireText(calendarName, "calendarName"),
  ]))}`;
}

function seriesKey(calendar, syncId) {
  if (!KEY.c.test(calendar ?? "")) throw new RecordError("calendar key is invalid");
  return `s_${sha256Hex(compactJson([calendar, requireText(syncId, "syncId")]))}`;
}

/** `originalStartMillis` is the occurrence's original start for recurring events, or null for single events. */
function occurrenceKey(series, originalStartMillis) {
  if (!KEY.s.test(series ?? "")) throw new RecordError("series key is invalid");
  if (originalStartMillis === null || originalStartMillis === undefined) return `e_${sha256Hex(`${series}:single`)}`;
  if (!Number.isSafeInteger(originalStartMillis)) throw new RecordError("original start must be epoch milliseconds");
  return `e_${sha256Hex(`${series}:${originalStartMillis}`)}`;
}

const isRecordId = (id) => typeof id === "string" && RECORD_ID.test(id);
const isCalendarKey = (id) => typeof id === "string" && KEY.c.test(id);
const isSeriesKey = (id) => typeof id === "string" && KEY.s.test(id);
const isEventKey = (id) => typeof id === "string" && KEY.e.test(id);

// ---- Google Calendar identities ----------------------------------------------------------------
//
// Assumptions, matching how Android's Google Calendar sync adapter fills CalendarContract (and so
// what the app hashes):
//   - accountType is "com.google" and accountName is the Google account's email address.
//   - The calendar's NAME column is the Google Calendar API calendarId (the account email for the
//     primary calendar, e.g. "...@group.calendar.google.com" for others).
//   - An event's _SYNC_ID is its Google Calendar API event id. A recurring series is identified by
//     the master's id; an exception keeps ORIGINAL_SYNC_ID = the master's id, so both resolve to
//     the same series key.
//   - Instance ids from the API are "<seriesId>_<YYYYMMDD>T<HHMMSS>Z" for timed events and
//     "<seriesId>_<YYYYMMDD>" for all-day events, the suffix being the original start in UTC.
//     Android stores all-day starts as UTC midnight, so "_20261020" means Date.UTC(2026, 9, 20).
//     Event ids use base32hex characters, so "_" only appears before such a suffix ("_R..."
//     suffixes of split series are different series and are left alone).
//   - A calendar may belong to a different Google account on the phone than the one signed in to
//     Always On Time, so callers try every candidate account name and keep the key the phone
//     actually published (see googleCalendarCandidates).

const GOOGLE_ACCOUNT_TYPE = "com.google";
const INSTANCE_SUFFIX = /^(.+)_(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/;

/** Splits a Google event id into its series id and, for instance ids, the original start. */
function parseGoogleEventId(eventId) {
  requireText(eventId, "eventId");
  const match = INSTANCE_SUFFIX.exec(eventId);
  if (!match) return { seriesId: eventId, originalStartMillis: null };
  const [, seriesId, year, month, day, hour, minute, second] = match.map((part, index) => (index > 1 && part !== undefined ? Number(part) : part));
  const millis = Date.UTC(year, month - 1, day, hour ?? 0, minute ?? 0, second ?? 0);
  const date = new Date(millis);
  // Reject impossible dates like 20261340 rather than letting Date roll them over.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { seriesId: eventId, originalStartMillis: null };
  }
  return { seriesId, originalStartMillis: millis };
}

/** Google's originalStartTime ({dateTime} or {date}) or an ISO string / epoch ms, as epoch ms. */
function originalStartMillis(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new RecordError("originalStartTime is invalid");
    return value;
  }
  const text = typeof value === "string" ? value : value.dateTime ?? value.date;
  if (typeof text !== "string") throw new RecordError("originalStartTime is invalid");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return Date.parse(`${text}T00:00:00Z`);
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) throw new RecordError("originalStartTime needs a time zone offset");
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) throw new RecordError("originalStartTime is invalid");
  return millis;
}

/**
 * Candidate calendar keys for a Google calendarId. The phone's account name is the Google account
 * that syncs the calendar: the signed-in account's email, or (for a primary calendar of another
 * account) the calendarId itself. Returns distinct {accountName, key} pairs, most likely first.
 */
// Shared, group and imported calendars ("…@group.calendar.google.com") are not account emails.
const GOOGLE_SHARED_CALENDAR_ID = /@([a-z0-9-]+\.)*calendar\.google\.com$/i;

function googleCalendarCandidates(calendarId, accountEmails = []) {
  requireText(calendarId, "calendarId");
  const names = [];
  const add = (name) => {
    if (typeof name === "string" && name.includes("@") && !names.includes(name)) names.push(name);
  };
  for (const email of accountEmails) {
    add(email);
    add(email?.toLowerCase());
  }
  if (!GOOGLE_SHARED_CALENDAR_ID.test(calendarId)) {
    add(calendarId);
    add(calendarId.toLowerCase());
  }
  return names.map((accountName) => ({ accountName, key: calendarKey(GOOGLE_ACCOUNT_TYPE, accountName, calendarId) }));
}

/**
 * Series and occurrence keys for a Google event under a known calendar key. `recurring` is true
 * when the input proves the event repeats (an instance id, recurringEventId or originalStartTime),
 * false when it is known to be single, and null when a bare id could be either.
 */
function googleEventKeys(calendar, { eventId, recurringEventId, originalStartTime, singleEvent } = {}) {
  const parsed = parseGoogleEventId(eventId);
  const seriesId = recurringEventId || parsed.seriesId;
  const start = originalStartMillis(originalStartTime) ?? parsed.originalStartMillis;
  const series = seriesKey(calendar, seriesId);
  if (start !== null) return { seriesKey: series, eventKey: occurrenceKey(series, start), recurring: true, originalStartMillis: start };
  // A recurring event without its original start names the series, not one occurrence.
  if (recurringEventId) return { seriesKey: series, eventKey: null, recurring: true, originalStartMillis: null };
  return { seriesKey: series, eventKey: occurrenceKey(series, null), recurring: singleEvent ? false : null, originalStartMillis: null };
}

// ---- Payloads ----------------------------------------------------------------------------------
//
// The canonical encoding of every payload is what the app's kotlinx serialization writes
// (AccountAlarmOverride and AccountCalendarRecord in CalendarAccountData.kt, PortablePreferences):
// fields in the data class order, null fields left out, lead-time lists ascending without
// duplicates. Fields a newer app added are kept, after the known ones, when the server rewrites a
// record; only the known fields are validated (plus the size limit). Comparisons between payloads
// go through canonicalPayload, never the raw strings. Vectors: docs/assistant-protocol-vectors.json.

const OVERRIDE_FIELDS = [
  "leadTimes", "enabled", "volume", "vibrationPattern", "ignoreAllDay", "rsvpFilter", "addedLeadTimes", "travelLeadTimes",
];
const CALENDAR_FIELDS = ["selected", "overrides"];
const LEAD_TIME_LISTS = new Set(["leadTimes", "addedLeadTimes", "travelLeadTimes"]);

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function intList(value, name, { min, max, minSize = 0, maxSize }) {
  if (!Array.isArray(value) || value.length < minSize || value.length > maxSize ||
      !value.every((item) => Number.isInteger(item) && item >= min && item <= max)) {
    throw new RecordError(`${name} must be ${minSize ? `${minSize}-` : "up to "}${maxSize} whole numbers from ${min} to ${max}`);
  }
}

/** Throws RecordError unless the known fields of `value` are a valid Override (absent or null fields inherit). */
function validateOverride(value) {
  if (!isPlainObject(value)) throw new RecordError("override must be an object");
  for (const field of OVERRIDE_FIELDS) {
    const item = value[field];
    if (item === null || item === undefined) continue;
    switch (field) {
      case "leadTimes":
      case "addedLeadTimes":
        intList(item, field, { min: LEAD_TIME_MIN, max: LEAD_TIME_MAX, maxSize: MAX_LEAD_TIMES });
        break;
      case "travelLeadTimes":
        intList(item, field, { min: 0, max: TRAVEL_LEAD_TIME_MAX, minSize: 1, maxSize: MAX_TRAVEL_LEAD_TIMES });
        break;
      case "enabled":
      case "ignoreAllDay":
        if (typeof item !== "boolean") throw new RecordError(`${field} must be true or false`);
        break;
      case "volume":
        if (!Number.isInteger(item) || item < 0 || item > 100) throw new RecordError("volume must be 0-100");
        break;
      case "vibrationPattern":
      case "rsvpFilter":
        if (typeof item !== "string" || item.length > 100) throw new RecordError(`${field} must be text up to 100 characters`);
        break;
    }
  }
  return value;
}

function validatePreference(name, value) {
  if (!PREFERENCE_NAMES.has(name)) throw new RecordError(`${name} is not a synced setting`);
  if (value === null) return value;
  if (PREFERENCE_BOOLEANS.has(name)) {
    if (typeof value !== "boolean") throw new RecordError(`${name} must be true or false`);
  } else if (PREFERENCE_INTEGERS.has(name)) {
    const [min, max] = PREFERENCE_INTEGERS.get(name);
    if (!Number.isInteger(value) || value < min || value > max) throw new RecordError(`${name} must be a whole number from ${min} to ${max}`);
  } else if (PREFERENCE_STRINGS.has(name)) {
    const allowed = PREFERENCE_STRINGS.get(name);
    if (typeof value !== "string" || value.length > PREFERENCE_STRING_MAX) throw new RecordError(`${name} must be text up to ${PREFERENCE_STRING_MAX} characters`);
    if (allowed && !allowed.includes(value)) throw new RecordError(`${name} must be one of ${allowed.join(", ")}`);
  } else {
    const [min, max] = PREFERENCE_LONGS.get(name);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new RecordError(`${name} must be 0, -1 or epoch milliseconds before 2100`);
  }
  return value;
}

function parseJson(payload) {
  if (typeof payload !== "string") throw new RecordError("payload must be a string");
  if (payload.length > MAX_PAYLOAD_CHARS) throw new RecordError("payload is too large");
  try {
    return JSON.parse(payload);
  } catch {
    throw new RecordError("payload is not JSON");
  }
}

/** Throws RecordError unless `value` is valid for `recordId`. Returns it. */
function validateValue(recordId, value) {
  if (!isRecordId(recordId)) throw new RecordError(`invalid record id ${recordId}`);
  if (recordId.startsWith("p_")) return validatePreference(recordId.slice(2), value);
  if (recordId.startsWith("c_")) {
    if (!isPlainObject(value)) throw new RecordError("calendar record must be an object");
    if (value.selected !== undefined && value.selected !== null && typeof value.selected !== "boolean") {
      throw new RecordError("selected must be true, false or null");
    }
    if (value.overrides !== undefined && value.overrides !== null) validateOverride(value.overrides);
    return value;
  }
  if (value === null) return value;
  return validateOverride(value);
}

/** Throws RecordError unless `payload` (the stored string) is valid for `recordId`. Returns the parsed value. */
function validatePayload(recordId, payload) {
  if (!isRecordId(recordId)) throw new RecordError(`invalid record id ${recordId}`);
  return validateValue(recordId, parseJson(payload));
}

const ascendingUnique = (list) => [...new Set(list)].sort((a, b) => a - b);

/** Known fields in `order` (null fields dropped), then any fields a newer app added, in their own order. */
function ordered(value, order, transform = (field, item) => item) {
  const out = {};
  for (const field of order) {
    const item = value[field];
    if (item !== null && item !== undefined) out[field] = transform(field, item);
  }
  for (const [field, item] of Object.entries(value)) {
    if (order.includes(field) || item === null || item === undefined || field === "__proto__") continue;
    out[field] = item;
  }
  return out;
}

const canonicalOverride = (value) => ordered(value, OVERRIDE_FIELDS, (field, item) => (LEAD_TIME_LISTS.has(field) ? ascendingUnique(item) : item));

/** The canonical form of a validated value. */
function canonicalValue(recordId, value) {
  if (recordId.startsWith("p_") || value === null) return value;
  if (recordId.startsWith("c_")) return ordered(value, CALENDAR_FIELDS, (field, item) => (field === "overrides" ? canonicalOverride(item) : item));
  return canonicalOverride(value);
}

/** Validates `value` and serializes it canonically, so nothing unchecked or non-canonical reaches Firestore. */
function encodePayload(recordId, value) {
  const checked = validateValue(recordId, value === undefined ? null : value);
  const payload = JSON.stringify(canonicalValue(recordId, checked));
  if (payload.length > MAX_PAYLOAD_CHARS) throw new RecordError("payload is too large");
  return payload;
}

/** What a missing record means: nothing set ("{}" for calendars, "null" otherwise). */
const unsetPayload = (recordId) => (recordId.startsWith("c_") ? "{}" : "null");

/**
 * A stored payload (or null for a missing document) in canonical form, for comparing by meaning.
 * A payload that does not validate is returned as stored, so it only equals itself.
 */
function canonicalPayload(recordId, payload) {
  if (payload === null || payload === undefined) return unsetPayload(recordId);
  try {
    return encodePayload(recordId, validatePayload(recordId, payload));
  } catch (error) {
    if (error instanceof RecordError) return payload;
    throw error;
  }
}

const samePayload = (recordId, a, b) => canonicalPayload(recordId, a) === canonicalPayload(recordId, b);

module.exports = {
  CALENDAR_FIELDS,
  GOOGLE_SHARED_CALENDAR_ID,
  GOOGLE_ACCOUNT_TYPE,
  MAX_PAYLOAD_CHARS,
  MAX_TRAVEL_LEAD_TIMES,
  OVERRIDE_FIELDS,
  PAUSED_UNTIL,
  PAUSED_UNTIL_MAX,
  PREFERENCE_BOOLEANS,
  PREFERENCE_INTEGERS,
  PREFERENCE_LONGS,
  PREFERENCE_NAMES,
  PREFERENCE_STRINGS,
  PREFERENCE_STRING_MAX,
  RecordError,
  TRAVEL_LEAD_TIME_MAX,
  calendarKey,
  canonicalPayload,
  encodePayload,
  googleCalendarCandidates,
  googleEventKeys,
  isCalendarKey,
  isEventKey,
  isRecordId,
  isSeriesKey,
  occurrenceKey,
  originalStartMillis,
  parseGoogleEventId,
  samePayload,
  seriesKey,
  sha256Hex,
  unsetPayload,
  validateOverride,
  validatePayload,
};

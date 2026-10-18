"use strict";

// The app-wide settings the assistant can read and change, and which changes could stop alarms
// from ringing or being heard (the activity entry's `alert`, docs/ASSISTANT_PROTOCOL.md
// "Activity"). Schemas come from the preference allowlist in assistant-records.js, so ranges and
// allowed values are defined once.

const z = require("zod");

const {
  PAUSED_UNTIL, PREFERENCE_BOOLEANS, PREFERENCE_INTEGERS, PREFERENCE_STRINGS,
} = require("./assistant-records");
const { formatTime, minutesLabel } = require("./assistant-snapshot");

// The app's pickers: up to four alarms per event (LeadTimeCodec.MAX_ALARMS_PER_EVENT), up to a week before.
const MAX_ALARMS_PER_EVENT = 4;
const LEAD_TIME_INPUT_MAX = 10080;

const leadTimesInput = z.array(z.number().int().min(0).max(LEAD_TIME_INPUT_MAX)).min(1).max(MAX_ALARMS_PER_EVENT)
  .describe(`Minutes before the start for each alarm, e.g. [10, 0] rings 10 minutes before and at the start. 1-${MAX_ALARMS_PER_EVENT} alarms, up to 7 days (${LEAD_TIME_INPUT_MAX}) before.`);

/** Lead times as the assistant reads them: distinct, earliest alarm first. Storage order is the encoder's job. */
const tidyLeadTimes = (list) => [...new Set(list)].sort((a, b) => b - a);
const leadTimesText = (list) => (list.length ? list.map(minutesLabel).join(", ") : "no alarms");

/** A stored payload string parsed, or null when missing or not JSON. */
function parseStored(payload) {
  if (payload === null || payload === undefined) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/** The zod schema for a preference, from its allowlist entry. */
function preferenceSchema(record) {
  if (PREFERENCE_BOOLEANS.has(record)) return z.boolean();
  if (PREFERENCE_INTEGERS.has(record)) {
    const [min, max] = PREFERENCE_INTEGERS.get(record);
    return z.number().int().min(min).max(max);
  }
  const values = PREFERENCE_STRINGS.get(record);
  if (values) return z.enum(values);
  throw new Error(`${record} has no assistant schema`);
}

const setting = (record, label, extra = {}) => ({ record, label, schema: preferenceSchema(record), ...extra });

const RSVP_FILTER_VALUES = PREFERENCE_STRINGS.get("rsvp_filter");

const SETTINGS = {
  defaultLeadTimes: {
    record: "default_lead_times_csv",
    label: "Default alarms",
    schema: leadTimesInput.describe(`Default alarms for every event, in minutes before the start (1-${MAX_ALARMS_PER_EVENT}).`),
    // The app stores its JSON list (LeadTimeCodec.encode: ascending, distinct) as a string.
    encode: (value) => JSON.stringify([...new Set(value)].sort((a, b) => a - b)),
    decode: (value) => {
      const list = typeof value === "string" ? parseStored(value) : null;
      return Array.isArray(list) ? list : value;
    },
  },
  alarmVolume: setting("alarm_volume", "Alarm volume (%)"),
  alarmDurationSeconds: setting("alarm_duration_seconds", "Ring for (seconds, 0 = until dismissed)"),
  gradualVolume: setting("gradual_volume_enabled", "Gradually increase volume"),
  vibration: setting("vibration_enabled", "Vibrate"),
  alertType: setting("alert_type", "Alert type"),
  snoozeMinutes: setting("snooze_duration_minutes", "Snooze length (minutes)"),
  maxSnoozes: setting("max_snoozes", "Maximum snoozes"),
  smartSnoozeSuggestions: setting("smart_snooze_suggestions", "Smart snooze suggestions"),
  respectDoNotDisturb: setting("respect_dnd", "Respect Do Not Disturb"),
  overrideSystemVolume: setting("override_system_volume", "Override system volume"),
  ignoreAllDayEvents: setting("ignore_all_day_events", "Skip all-day events"),
  rsvpFilter: setting("rsvp_filter", "Which invitations ring"),
  autoDetectMeetingLinks: setting("auto_detect_meeting_urls", "Detect meeting links"),
  spokenAlarmEventName: setting("spoken_alarm_include_event_name", "Spoken alarm says the event name"),
  spokenAlarmTimeUntil: setting("spoken_alarm_include_time_until_event", "Spoken alarm says the time until the event"),
  spokenAlarmLocation: setting("spoken_alarm_include_location", "Spoken alarm says the location"),
  spokenAlarmReminder: setting("spoken_alarm_include_helpful_reminder", "Spoken alarm adds a helpful reminder"),
  spokenAlarmSpeechRate: setting("spoken_alarm_speech_rate_hundredths", "Speech rate (%)"),
  theme: setting("theme_preference", "Theme"),
  dynamicColor: setting("dynamic_color", "Use wallpaper colors"),
  applyAccentToApp: setting("apply_accent_to_app", "Apply accent color to the app"),
};

function describePause(until, timeZone) {
  if (until === -1) return "paused until resumed";
  if (Number.isFinite(until) && until > 0) return `paused until ${formatTime(until, timeZone)}`;
  return "on";
}

// ---- Alerts ------------------------------------------------------------------------------------

// Most serious first. Phones word the first four specially and any other value generically
// ("changed how your alarms ring"), always with an undo action.
const ALERTS = ["paused", "calendar_unwatched", "alarms_off", "alerts_reduced", "alarms_filtered", "alarms_shortened", "alarms_early"];
// How much of an alarm the user notices, by alert type (AlertType.kt): sound and vibration, a
// silent vibration, or a screen notification only. Unset means the app default, sound and vibration.
const ALERT_TYPE_RANK = { sound_and_vibration: 2, vibration_only: 1, visual_only: 0 };
const DEFAULT_ALERT_TYPE = "sound_and_vibration";
const DEFAULT_ALARM_VOLUME = 80;
const QUIET_VOLUME = 20;
// The app's defaults for settings an alert compares against (UserPreferencesRepository.kt).
const DEFAULTS = {
  p_respect_dnd: false, p_override_system_volume: false, p_ignore_all_day_events: true, p_rsvp_filter: "not_declined",
  p_alarm_duration_seconds: 60,
};
// A ring this short (seconds; 0 rings until dismissed) is easy to miss.
const SHORT_ALARM_SECONDS = 15;
// A lead time over a day moves an alarm far from its event.
const EARLY_LEAD_MINUTES = 1440;
const LEAD_TIME_FIELDS = ["leadTimes", "addedLeadTimes"];

/** The Override a record holds (calendars keep it under `overrides`), or null. */
function overrideOf(recordId, value) {
  const override = recordId.startsWith("c_") ? value?.overrides : value;
  return override && typeof override === "object" && !Array.isArray(override) ? override : null;
}

/** The `enabled` an override record sets, or null. */
const enabledOf = (recordId, value) => overrideOf(recordId, value)?.enabled ?? null;

/** Every lead time (minutes) a record sets: override lists, or the app default preferences. */
function leadTimesOf(recordId, value) {
  if (recordId === "p_default_lead_times_csv") {
    const list = typeof value === "string" ? parseStored(value) : null;
    return Array.isArray(list) ? list : [];
  }
  if (recordId === "p_default_lead_time_minutes") return Number.isInteger(value) ? [value] : [];
  const override = /^[cse]_/.test(recordId) ? overrideOf(recordId, value) : null;
  return LEAD_TIME_FIELDS.flatMap((field) => (Array.isArray(override?.[field]) ? override[field] : []));
}

const lower = (value) => (typeof value === "string" ? value.toLowerCase() : value);

/**
 * Which alert, if any, an activity entry gets: a change that could stop alarms from ringing or
 * being heard. `records` are the change's {before, after} payloads; `current` holds payloads the
 * change read, including ones it left alone (update_settings reads p_alert_type to judge
 * turning vibration off). The most serious alert wins.
 */
function changeAlert(records, current = {}) {
  const before = (id) => parseStored(records[id] ? records[id].before : current[id]);
  const after = (id) => parseStored(records[id] ? records[id].after : current[id]);
  const changed = Object.keys(records);
  const overrides = changed.filter((id) => /^[cse]_/.test(id));
  /** A preference this change set to `value` that was effectively something else before. */
  const became = (id, value) => Boolean(records[id]) && after(id) === value && (before(id) ?? DEFAULTS[id]) !== value;
  /** An override field this change turned to `value` (compared case-insensitively) from something else. */
  const overrideBecame = (field, value) => overrides.some((id) =>
    lower(overrideOf(id, after(id))?.[field]) === value && lower(overrideOf(id, before(id))?.[field]) !== value);
  const pause = `p_${PAUSED_UNTIL}`;
  if (records[pause]) {
    const until = after(pause);
    if (until === -1 || (Number.isFinite(until) && until > 0)) return "paused";
  }
  if (changed.some((id) => id.startsWith("c_") && after(id)?.selected === false && before(id)?.selected !== false)) {
    return "calendar_unwatched";
  }
  if (overrides.some((id) => enabledOf(id, after(id)) === false && enabledOf(id, before(id)) !== false)) {
    return "alarms_off";
  }
  if (records.p_alarm_volume) {
    const volume = after("p_alarm_volume");
    if (Number.isInteger(volume) && volume <= QUIET_VOLUME && volume < (before("p_alarm_volume") ?? DEFAULT_ALARM_VOLUME)) return "alerts_reduced";
  }
  const alertType = (value) => ALERT_TYPE_RANK[value] ?? ALERT_TYPE_RANK[DEFAULT_ALERT_TYPE];
  if (records.p_alert_type && alertType(after("p_alert_type")) < alertType(before("p_alert_type"))) return "alerts_reduced";
  if (records.p_vibration_enabled && after("p_vibration_enabled") === false && before("p_vibration_enabled") !== false &&
      (after("p_alert_type") ?? DEFAULT_ALERT_TYPE) === "vibration_only") {
    return "alerts_reduced";
  }
  // Silent during Do Not Disturb, or at the phone's own alarm volume.
  if (became("p_respect_dnd", true) || became("p_override_system_volume", false)) return "alerts_reduced";
  if (overrides.some((id) => overrideOf(id, before(id))?.ringThroughDnd === true && overrideOf(id, after(id))?.ringThroughDnd !== true)) {
    return "alerts_reduced";
  }
  // Whole groups of events stop ringing: everything not accepted, or all-day events.
  if (became("p_rsvp_filter", "accepted_only") || overrideBecame("rsvpFilter", "accepted_only")) return "alarms_filtered";
  if (became("p_ignore_all_day_events", true) || overrideBecame("ignoreAllDay", true)) return "alarms_filtered";
  if (records.p_alarm_duration_seconds) {
    const seconds = after("p_alarm_duration_seconds");
    const was = before("p_alarm_duration_seconds") ?? DEFAULTS.p_alarm_duration_seconds;
    if (Number.isInteger(seconds) && seconds > 0 && seconds <= SHORT_ALARM_SECONDS && (was === 0 || seconds < was)) return "alarms_shortened";
  }
  const early = (id, value) => leadTimesOf(id, value).filter((minutes) => Number.isInteger(minutes) && minutes > EARLY_LEAD_MINUTES);
  if (changed.some((id) => {
    const was = new Set(early(id, before(id)));
    return early(id, after(id)).some((minutes) => !was.has(minutes));
  })) {
    return "alarms_early";
  }
  return null;
}

module.exports = {
  ALERTS,
  MAX_ALARMS_PER_EVENT,
  RSVP_FILTER_VALUES,
  SETTINGS,
  changeAlert,
  describePause,
  leadTimesInput,
  leadTimesText,
  parseStored,
  preferenceSchema,
  tidyLeadTimes,
};

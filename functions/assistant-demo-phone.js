"use strict";

// A stand-in phone for the review account (docs/ASSISTANT_CONNECTOR.md "Review account"). People
// who review the connector for Claude's and ChatGPT's app directories sign in with a password
// account that has no phone, so for that one account (the ASSISTANT_DEMO_UID param) the server
// plays the phone: it registers a device, publishes a snapshot of a fictional week and answers
// sync, publish and ping messages in-process instead of over FCM. Every entry point compares the
// uid with the configured demo uid before reading anything, so other accounts are never touched.
//
// The snapshot approximates how the app resolves alarms (docs/ASSISTANT_PROTOCOL.md "Record keys
// and payloads"): enough to show every tool working, not a second implementation of the app.

const { deleteCollection, refs, toMillis } = require("./assistant-data");
const {
  GOOGLE_ACCOUNT_TYPE, PAUSED_UNTIL, calendarKey, encodePayload, occurrenceKey, seriesKey,
} = require("./assistant-records");
const { parseStored } = require("./assistant-settings");
const { parseTime } = require("./assistant-snapshot");

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
// A UUID like a phone's install id; a document marked demoPhone, which phones can't write (firestore.rules).
const DEMO_DEVICE_ID = "d3e0d3e0-0000-4000-8000-000000000001";
const DEMO_DEVICE_NAME = "Pixel 9 (demo)";
const DEMO_ACCOUNT_EMAIL = "demo@example.com";
const DEMO_TIME_ZONE = "America/Los_Angeles";
// The snapshot is rebuilt when older than this, so the week keeps rolling forward.
const SNAPSHOT_MAX_AGE_MS = 60 * MINUTE_MS;
const WINDOW_DAYS = 7;
const HISTORY_DAYS = 3;
// The app's defaults (UserPreferencesRepository.kt).
const APP_DEFAULTS = { leadTimes: [10, 0], rsvpFilter: "not_declined", ignoreAllDay: true };
const RSVP_FILTERS = ["accepted_only", "accepted_or_tentative", "not_declined", "all_events"];

const isDemoAccount = (uid, demoUid) => typeof demoUid === "string" && demoUid.length > 0 && uid === demoUid;
const isDemoPhone = (device) => device?.demoPhone === true;
/** Whether `device` of account `uid` is the stand-in phone: only the configured demo account has one. */
const isDemoDelivery = (uid, device, demoUid) => isDemoAccount(uid, demoUid) && isDemoPhone(device);

// ---- The fictional week ------------------------------------------------------------------------

// Two Google calendars of a fictional account, keyed as the app keys them.
const CALENDARS = [
  { id: "work", name: "Work", calendarId: DEMO_ACCOUNT_EMAIL },
  { id: "personal", name: "Personal", calendarId: "demo.personal@group.calendar.google.com" },
].map((calendar) => ({ ...calendar, key: calendarKey(GOOGLE_ACCOUNT_TYPE, DEMO_ACCOUNT_EMAIL, calendar.calendarId) }));

// Weekly pattern (days: 0 = Sunday), times in DEMO_TIME_ZONE. Recurring events are one series;
// single events get an id per date, so each date's event keeps its keys across rebuilds.
const SCHEDULE = [
  { id: "standup", calendar: "work", title: "Team standup", days: [1, 2, 3, 4, 5], start: "09:30", minutes: 15, recurring: true, rsvp: "ACCEPTED" },
  { id: "productdemo", calendar: "work", title: "Product demo with Example Co.", days: [1], start: "11:00", minutes: 30, rsvp: "INVITED" },
  { id: "oneonone", calendar: "work", title: "1:1 with Sam", days: [2], start: "14:00", minutes: 30, recurring: true, rsvp: "ACCEPTED" },
  { id: "designreview", calendar: "work", title: "Design review: onboarding flow", days: [3], start: "15:00", minutes: 60, rsvp: "TENTATIVE" },
  { id: "teamlunch", calendar: "work", title: "Team lunch", days: [4], start: "12:00", minutes: 60, rsvp: "ACCEPTED" },
  { id: "lunchlearn", calendar: "work", title: "Lunch and learn", days: [5], start: "12:00", minutes: 60, rsvp: "DECLINED" },
  { id: "retro", calendar: "work", title: "Sprint retro", days: [5], start: "16:00", minutes: 45, recurring: true, rsvp: "ORGANIZER" },
  { id: "dentist", calendar: "personal", title: "Dentist appointment", days: [2], start: "08:00", minutes: 60 },
  { id: "yoga", calendar: "personal", title: "Yoga class", days: [4], start: "18:30", minutes: 60, recurring: true },
  { id: "flight", calendar: "personal", title: "Flight to Denver", days: [6], start: "07:15", minutes: 150 },
  { id: "birthday", calendar: "personal", title: "Sam's birthday", days: [0], allDay: true, recurring: true },
];

// Settings the seed script writes, so explain_alarm shows a series and a calendar rule next to
// the app default.
function demoSeedValues() {
  const work = CALENDARS.find((calendar) => calendar.id === "work");
  const personal = CALENDARS.find((calendar) => calendar.id === "personal");
  return {
    [seriesKey(work.key, "demooneonone")]: { leadTimes: [5, 15], enabled: true },
    [personal.key]: { selected: true, overrides: { leadTimes: [5, 30] } },
  };
}

const DATE_PARTS = new Intl.DateTimeFormat("en-US", { timeZone: DEMO_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** The local date of `ms` as UTC midnight of that date (a day label free of daylight saving). */
function localDay(ms) {
  const parts = Object.fromEntries(DATE_PARTS.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
}
const dateText = (day) => new Date(day).toISOString().slice(0, 10);
const wallTime = (day, time) => parseTime(`${dateText(day)}T${time}`, DEMO_TIME_ZONE);

/** Occurrences from local day `fromOffset` to `toOffset` (relative to today), with their keys. */
function occurrences(now, fromOffset, toOffset) {
  const today = localDay(now);
  const out = [];
  for (let offset = fromOffset; offset <= toOffset; offset += 1) {
    const day = today + offset * DAY_MS;
    for (const item of SCHEDULE) {
      if (!item.days.includes(new Date(day).getUTCDay())) continue;
      const calendar = CALENDARS.find((entry) => entry.id === item.calendar);
      const start = wallTime(day, item.allDay ? "00:00" : item.start);
      const end = item.allDay ? wallTime(day + DAY_MS, "00:00") : start + item.minutes * MINUTE_MS;
      const syncId = item.recurring ? `demo${item.id}` : `demo${item.id}${dateText(day).replace(/-/g, "")}`;
      const series = seriesKey(calendar.key, syncId);
      out.push({ item, calendar, start, end, seriesKey: series, eventKey: occurrenceKey(series, item.recurring ? start : null) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---- Alarm resolution --------------------------------------------------------------------------

const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const intList = (value) => (Array.isArray(value) ? value.filter(Number.isInteger) : null);
const bool = (value) => (typeof value === "boolean" ? value : null);
const rsvpFilterOf = (value) => (typeof value === "string" && RSVP_FILTERS.includes(value.toLowerCase()) ? value.toLowerCase() : null);

/** App-wide settings from the parsed `values` (p_ records), with the app's defaults. */
function appSettings(values, now) {
  // default_lead_times_csv holds a JSON list as a string.
  const csv = typeof values.p_default_lead_times_csv === "string" ? intList(parseStored(values.p_default_lead_times_csv)) : null;
  const paused = values[`p_${PAUSED_UNTIL}`];
  return {
    leadTimes: csv?.length ? csv : APP_DEFAULTS.leadTimes,
    rsvpFilter: rsvpFilterOf(values.p_rsvp_filter) ?? APP_DEFAULTS.rsvpFilter,
    ignoreAllDay: bool(values.p_ignore_all_day_events) ?? APP_DEFAULTS.ignoreAllDay,
    // -1 pauses until resumed; a past time no longer pauses anything.
    pausedUntil: paused === -1 ? -1 : Number.isSafeInteger(paused) && paused > now ? paused : 0,
  };
}

/** A calendar's record and effective settings. Without a `selected` record a calendar is watched. */
function calendarSettings(calendar, values, app) {
  const record = asObject(values[calendar.key]);
  const overrides = asObject(record.overrides);
  return {
    overrides,
    watched: bool(record.selected) ?? true,
    leadTimes: intList(overrides.leadTimes) ?? app.leadTimes,
    enabled: bool(overrides.enabled) ?? true,
    rsvpFilter: rsvpFilterOf(overrides.rsvpFilter) ?? app.rsvpFilter,
    includeAllDay: !(bool(overrides.ignoreAllDay) ?? app.ignoreAllDay),
  };
}

/** Whether an invitation answered `rsvp` rings under `filter`. Own events (no answer, organizer) always do. */
function ringsFor(filter, rsvp) {
  if (filter === "all_events") return true;
  if (rsvp === "DECLINED") return false;
  if (filter === "not_declined") return true;
  if (rsvp === "INVITED") return false;
  if (rsvp === "TENTATIVE") return filter === "accepted_or_tentative";
  return true;
}

/**
 * An occurrence's alarms. Lead times come from the first level that sets them (occurrence, series,
 * calendar, then the app default) and `addedLeadTimes` at any level add to them; `enabled` from
 * the first level that sets it turns them off.
 */
function resolveAlarms(occurrence, calendar, values, app, now) {
  const levels = [["event", asObject(values[occurrence.eventKey])], ["series", asObject(values[occurrence.seriesKey])], ["calendar", calendar.overrides]];
  const leadLevel = levels.find(([, override]) => intList(override.leadTimes));
  const minutes = new Map((leadLevel ? intList(leadLevel[1].leadTimes) : app.leadTimes).map((lead) => [lead, leadLevel ? leadLevel[0] : "app"]));
  for (const [level, override] of levels) {
    for (const lead of intList(override.addedLeadTimes) ?? []) if (!minutes.has(lead)) minutes.set(lead, level);
  }
  const enabled = levels.map(([, override]) => bool(override.enabled)).find((value) => value !== null) ?? true;
  return [...minutes].map(([lead, source]) => {
    const at = occurrence.start - lead * MINUTE_MS;
    const paused = app.pausedUntil === -1 || at < app.pausedUntil;
    const status = at <= now ? "past" : !enabled ? "off" : paused ? "paused" : "on";
    return { at, kind: "lead", minutes: lead, source, status };
  }).sort((a, b) => a.at - b.at);
}

/**
 * The snapshot payload the stand-in phone publishes (docs/ASSISTANT_PROTOCOL.md "Snapshot") for
 * the parsed account `values` at `now`.
 */
function buildDemoSnapshot(values, now, valuesAppliedThrough = 0) {
  const app = appSettings(values, now);
  const windowEnd = now + WINDOW_DAYS * DAY_MS;
  const calendars = new Map(CALENDARS.map((calendar) => [calendar.id, calendarSettings(calendar, values, app)]));
  const events = occurrences(now, 0, WINDOW_DAYS)
    .filter((occurrence) => occurrence.end > now && occurrence.start < windowEnd)
    .filter((occurrence) => {
      const calendar = calendars.get(occurrence.calendar.id);
      return calendar.watched && ringsFor(calendar.rsvpFilter, occurrence.item.rsvp ?? null)
        && (!occurrence.item.allDay || calendar.includeAllDay);
    })
    .map((occurrence) => ({
      eventKey: occurrence.eventKey,
      seriesKey: occurrence.seriesKey,
      calendarKey: occurrence.calendar.key,
      title: occurrence.item.title,
      start: occurrence.start,
      end: occurrence.end,
      allDay: Boolean(occurrence.item.allDay),
      recurring: Boolean(occurrence.item.recurring),
      ...(occurrence.item.rsvp ? { rsvp: occurrence.item.rsvp } : {}),
      alarms: resolveAlarms(occurrence, calendars.get(occurrence.calendar.id), values, app, now),
    }));
  return {
    device: DEMO_DEVICE_NAME,
    builtAt: now,
    timeZone: DEMO_TIME_ZONE,
    valuesAppliedThrough,
    windowEnd,
    paused: { until: app.pausedUntil },
    calendars: CALENDARS.map((calendar) => {
      const settings = calendars.get(calendar.id);
      return {
        key: calendar.key, name: calendar.name, accountType: GOOGLE_ACCOUNT_TYPE, watched: settings.watched,
        leadTimes: settings.leadTimes, enabled: settings.enabled, rsvpFilter: settings.rsvpFilter, includeAllDay: settings.includeAllDay,
      };
    }),
    events,
  };
}

/**
 * A few days of alarm history for the past events (the account's history collection, which the
 * real app syncs): each rang ten minutes before and was dismissed, some after a snooze. Document
 * ids are stable, so rewriting them is idempotent; the daily history pruning removes old ones.
 */
function demoHistory(now) {
  return occurrences(now, -HISTORY_DAYS, 0)
    .filter((occurrence) => !occurrence.item.allDay && occurrence.item.rsvp !== "DECLINED" && occurrence.start - 10 * MINUTE_MS < now - 5 * MINUTE_MS)
    .map((occurrence) => {
      const scheduledTime = occurrence.start - 10 * MINUTE_MS;
      const snoozed = parseInt(occurrence.eventKey.slice(2, 4), 16) % 3 === 0;
      const actionTime = scheduledTime + (snoozed ? 6 : 1) * MINUTE_MS;
      return {
        id: `demo_${occurrence.eventKey.slice(2, 22)}`,
        createdAt: actionTime,
        payload: JSON.stringify({
          deviceId: DEMO_DEVICE_ID, deviceName: DEMO_DEVICE_NAME, title: occurrence.item.title, scheduledTime, firedTime: scheduledTime,
          action: "DISMISSED", actionTime, snoozeCount: snoozed ? 1 : 0, snoozeMinutes: snoozed ? 5 : null, leadTimeMinutes: 10, createdAt: actionTime,
        }),
      };
    });
}

// ---- Firestore ---------------------------------------------------------------------------------

/** The account's values, parsed, and the greatest updatedAt among them (what a phone reports as applied). */
async function readDemoValues(db, uid) {
  const page = await refs.values(db, uid).get();
  const values = {};
  let appliedThrough = 0;
  for (const doc of page.docs) {
    const data = doc.data();
    values[doc.id] = parseStored(data.payload);
    const updatedAt = toMillis(data.updatedAt);
    if (updatedAt !== null && updatedAt > appliedThrough) appliedThrough = updatedAt;
  }
  return { values, appliedThrough };
}

const deviceDocument = (now) => ({
  platform: "android", deviceName: DEMO_DEVICE_NAME, capabilities: ["pause", "plus"], demoPhone: true, updatedAt: new Date(now),
});

/** Rebuilds and publishes the snapshot from the current values, echoing `requestId` when a publish asked for it. */
async function publishDemoSnapshot(db, uid, deviceId, now, { requestId = null } = {}) {
  const { values, appliedThrough } = await readDemoValues(db, uid);
  const payload = buildDemoSnapshot(values, now, appliedThrough);
  await refs.snapshots(db, uid).doc(deviceId).set({
    schemaVersion: 1, publishedAt: new Date(now), ...(requestId ? { requestId } : {}), payload: JSON.stringify(payload),
  });
  const batch = db.batch();
  for (const entry of demoHistory(now)) batch.set(refs.history(db, uid).doc(entry.id), { createdAt: entry.createdAt, payload: entry.payload });
  await batch.commit();
  return payload;
}

const connected = async (db, uid) => {
  const state = await refs.state(db, uid).get();
  return state.exists && state.data().connected === true;
};

/**
 * Makes sure the demo account's stand-in phone is registered and its snapshot current: rebuilt
 * when missing, older than SNAPSHOT_MAX_AGE_MS, or behind a value saved since (a change whose
 * message was rate limited). Like a real phone, it only registers while an assistant is
 * connected and the account is active. Returns what it did, or null for any other account
 * (decided before any read).
 */
async function ensureDemoPhone(db, uid, now, demoUid) {
  if (!isDemoAccount(uid, demoUid)) return null;
  const deviceRef = refs.devices(db, uid).doc(DEMO_DEVICE_ID);
  const [account, isConnected, device, snapshot, newest] = await Promise.all([
    refs.account(db, uid).get(), connected(db, uid), deviceRef.get(), refs.snapshots(db, uid).doc(DEMO_DEVICE_ID).get(),
    refs.values(db, uid).orderBy("updatedAt", "desc").limit(1).get(),
  ]);
  if (!account.exists || account.data().active !== true || !isConnected) return "inactive";
  if (!device.exists) await deviceRef.set(deviceDocument(now));
  const published = snapshot.exists ? toMillis(snapshot.data().publishedAt) : null;
  let applied = 0;
  try {
    applied = JSON.parse(snapshot.exists ? snapshot.data().payload : "{}").valuesAppliedThrough ?? 0;
  } catch {
    applied = 0;
  }
  const latestValue = newest.docs[0] ? toMillis(newest.docs[0].data().updatedAt) ?? 0 : 0;
  if (published === null || now - published > SNAPSHOT_MAX_AGE_MS || latestValue > applied) {
    await publishDemoSnapshot(db, uid, DEMO_DEVICE_ID, now);
    return device.exists ? "published" : "registered";
  }
  return device.exists ? "current" : "registered";
}

/** Deletes the stand-in phone's device and snapshot, as a phone does when its account disconnects. */
async function removeDemoPhone(db, uid, deviceId = DEMO_DEVICE_ID) {
  await Promise.all([refs.devices(db, uid).doc(deviceId).delete(), refs.snapshots(db, uid).doc(deviceId).delete()]);
}

/**
 * Handles a push message for the stand-in phone the way the app does (docs/ASSISTANT_PROTOCOL.md
 * "Push messages"). Callers check isDemoDelivery first; this throws only when Firestore fails.
 */
async function deliverToDemoPhone(db, uid, deviceId, type, data, now) {
  if (type === "sync") await publishDemoSnapshot(db, uid, deviceId, now);
  else if (type === "publish") await publishDemoSnapshot(db, uid, deviceId, now, { requestId: String(data.requestId).slice(0, 64) });
  else if (type === "ping") {
    await refs.devices(db, uid).doc(deviceId).update({ lastPing: { id: String(data.pingId).slice(0, 64), receivedAt: new Date(now) }, updatedAt: new Date(now) });
  } else if (type === "state") {
    if (!(await connected(db, uid))) await removeDemoPhone(db, uid, deviceId);
  } else throw new TypeError(`unknown message type ${type}`);
}

/**
 * Seed and reset (scripts/seed-review-account.js): the account active as a phone's account sync
 * leaves it, its values back to the demo settings, and its activity, history, snapshot and
 * stand-in phone cleared (rebuilt on the next tool call). Connections are left alone. Refuses an
 * account that was deleted (its tombstone is inactive).
 */
async function resetDemoAccount(db, uid) {
  const account = await refs.account(db, uid).get();
  if (account.exists && account.data().active !== true) throw new Error("this account was deleted; create a new one");
  if (!account.exists) await refs.account(db, uid).set({ active: true, schemaVersion: 1 });
  for (const collection of [refs.values(db, uid), refs.activity(db, uid), refs.history(db, uid), refs.snapshots(db, uid), refs.devices(db, uid)]) {
    await deleteCollection(db, collection);
  }
  // Written like a phone writes them (payload only, no updatedAt), so they count as already applied.
  const batch = db.batch();
  for (const [recordId, value] of Object.entries(demoSeedValues())) {
    batch.set(refs.values(db, uid).doc(recordId), { payload: encodePayload(recordId, value) });
  }
  await batch.commit();
}

module.exports = {
  CALENDARS,
  DEMO_ACCOUNT_EMAIL,
  DEMO_DEVICE_ID,
  DEMO_DEVICE_NAME,
  DEMO_TIME_ZONE,
  SNAPSHOT_MAX_AGE_MS,
  buildDemoSnapshot,
  deliverToDemoPhone,
  demoHistory,
  demoSeedValues,
  ensureDemoPhone,
  isDemoAccount,
  isDemoDelivery,
  isDemoPhone,
  publishDemoSnapshot,
  removeDemoPhone,
  resetDemoAccount,
};

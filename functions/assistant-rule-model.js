"use strict";
// Pure portable model; helpers injected to share the app's keyword cleaner and RecordError.
function model({ RecordError, cleanSkipKeyword, foldSkipKeyword }) {
  const fail = (message) => {
    throw new RecordError(message);
  };
  const object = (v) =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  const ordered = (v, keys) =>
    Object.fromEntries(
      [
        ...keys,
        ...Object.keys(v).filter((k) => !keys.includes(k) && k !== "__proto__"),
      ]
        .filter((k) => v[k] != null)
        .map((k) => [k, v[k]]),
    );
  function validateRingOptions(v) {
    if (!object(v)) fail("ring options must be an object");
    if (v.style != null && !["alarm", "notification"].includes(v.style))
      fail("style must be alarm or notification");
    if (
      v.label != null &&
      (typeof v.label !== "string" ||
        v.label.length > 40 ||
        v.label !== cleanSkipKeyword(v.label))
    )
      fail("label must be tidy text up to 40 UTF-16 units");
    return v;
  }
  function canonicalRingOptions(v, minutes) {
    if (!object(v)) fail("ringOptions must be a map");
    const out = {};
    for (const key of Object.keys(v).sort((a, b) => Number(a) - Number(b))) {
      if (
        String(Number(key)) !== key ||
        !Number.isInteger(Number(key)) ||
        !minutes.includes(Number(key))
      )
        continue;
      const option =
        object(v[key]) && typeof v[key].label === "string"
          ? { ...v[key], label: cleanSkipKeyword(v[key].label) }
          : v[key];
      const fields = ordered(validateRingOptions(option), ["label", "style"]);
      if (!fields.label) delete fields.label;
      if (fields.style === "alarm") delete fields.style;
      if (Object.keys(fields).length) out[key] = fields;
    }
    return out;
  }
  function validateRule(v) {
    if (
      !object(v) ||
      typeof v.enabled !== "boolean" ||
      !Number.isInteger(v.order) ||
      v.order < -2147483648 ||
      v.order > 2147483647 ||
      !Array.isArray(v.when) ||
      v.when.length < 1 ||
      v.when.length > 4 ||
      !object(v.then)
    )
      fail("invalid rule structure");
    if (
      !["user", "assistant"].includes(v.createdBy) ||
      !Number.isSafeInteger(v.createdAt) ||
      v.createdAt < 0 ||
      (v.assistantName != null &&
        (v.createdBy !== "assistant" ||
          typeof v.assistantName !== "string" ||
          v.assistantName.length < 1 ||
          v.assistantName.length > 100))
    )
      fail("invalid rule creator");
    for (const c of v.when) {
      if (!object(c) || typeof c.type !== "string") fail("invalid condition");
      if (
        (c.text != null && typeof c.text !== "string") ||
        (c.calendarKey != null && typeof c.calendarKey !== "string") ||
        (c.hours != null && !Number.isInteger(c.hours)) ||
        (c.compare != null && typeof c.compare !== "string") ||
        (c.minute != null && !Number.isInteger(c.minute)) ||
        (c.days != null && !Array.isArray(c.days)) ||
        (c.has != null && typeof c.has !== "boolean") ||
        (c.count != null && !Number.isInteger(c.count))
      )
        fail("invalid condition field");
      if (c.type === "time_of_day") {
        if (!["before", "after"].includes(c.compare))
          fail("time of day must be before or after");
        if (c.minute == null || c.minute < 0 || c.minute > 1439)
          fail("time of day minute must be 0–1439");
      }
      if (c.type === "day_of_week") {
        if (
          !Array.isArray(c.days) ||
          c.days.length < 1 ||
          c.days.length > 6 ||
          !c.days.every(
            (d, i) =>
              Number.isInteger(d) &&
              d >= 1 &&
              d <= 7 &&
              (i === 0 || d > c.days[i - 1]),
          )
        )
          fail("days must be 1–6 sorted, unique ISO days 1–7");
      }
      if (["video_link", "location"].includes(c.type) && c.has == null)
        fail(`${c.type} needs has true or false`);
      if (c.type === "attendees") {
        if (!["at_least", "at_most"].includes(c.compare))
          fail("attendees must be at_least or at_most");
        if (c.count == null || c.count < 1 || c.count > 99)
          fail("attendees count must be 1–99");
        if (c.compare === "at_least" && c.count === 1)
          fail("at least 1 attendee matches everything");
      }
      if (
        ["title_contains", "next_after"].includes(c.type) &&
        (typeof c.text !== "string" ||
          !cleanSkipKeyword(c.text).length ||
          cleanSkipKeyword(c.text).length > 60 ||
          !foldSkipKeyword(cleanSkipKeyword(c.text)).length)
      )
        fail("invalid matching text");
      if (
        c.type === "next_after" &&
        (!Number.isInteger(c.hours ?? 2) ||
          (c.hours ?? 2) < 1 ||
          (c.hours ?? 2) > 6)
      )
        fail("hours must be 1–6");
      if (
        c.type === "on_calendar" &&
        (typeof c.calendarKey !== "string" || !c.calendarKey.startsWith("c_"))
      )
        fail("invalid calendar key");
    }
    for (const type of [
      "first_of_day",
      "next_after",
      "time_of_day",
      "day_of_week",
      "video_link",
      "location",
      "attendees",
    ])
      if (v.when.filter((c) => c.type === type).length > 1)
        fail("duplicate condition");
    if (typeof v.then.type !== "string") fail("invalid action");
    if (
      (v.then.minutes != null && !Number.isInteger(v.then.minutes)) ||
      (v.then.label != null && typeof v.then.label !== "string") ||
      (v.then.style != null && typeof v.then.style !== "string")
    )
      fail("invalid action field");
    if (v.then.type === "add_ring") {
      if (
        !Number.isInteger(v.then.minutes) ||
        v.then.minutes < 1 ||
        v.then.minutes > 2880
      )
        fail("rule minutes must be 1–2880");
      validateRingOptions(v.then);
    }
    return v;
  }
  function canonicalRule(v) {
    const out = ordered(v, [
      "enabled",
      "order",
      "when",
      "then",
      "createdBy",
      "createdAt",
      "assistantName",
    ]);
    out.when = v.when.map((c) =>
      ordered(c, [
        "type",
        "text",
        "calendarKey",
        "hours",
        "compare",
        "minute",
        "days",
        "has",
        "count",
      ]),
    );
    out.then = ordered(v.then, ["type", "minutes", "label", "style"]);
    return out;
  }
  return {
    validateRule,
    canonicalRule,
    validateRingOptions,
    canonicalRingOptions,
  };
}
module.exports = { model };

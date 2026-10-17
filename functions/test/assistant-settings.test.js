"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { PREFERENCE_NAMES } = require("../assistant-records");
const { SETTINGS, changeAlert } = require("../assistant-settings");

const { preferences } = require(path.join(__dirname, "../../docs/assistant-protocol-vectors.json"));

test("every assistant setting is a synced preference and accepts exactly the shared vectors' values", () => {
  for (const [field, setting] of Object.entries(SETTINGS)) {
    assert.ok(PREFERENCE_NAMES.has(setting.record), field);
    const { schema, record } = setting;
    if (preferences.booleans.includes(record)) {
      assert.equal(schema.safeParse(true).success, true, field);
      assert.equal(schema.safeParse(1).success, false, field);
    } else if (record in preferences.integers) {
      const [min, max] = preferences.integers[record];
      for (const ok of [min, max]) assert.equal(schema.safeParse(ok).success, true, `${field} ${ok}`);
      for (const bad of [min - 1, max + 1, min + 0.5]) assert.equal(schema.safeParse(bad).success, false, `${field} ${bad}`);
    } else if (field === "defaultLeadTimes") {
      // Stored as the app's JSON list in a string preference with no fixed values.
      assert.equal(preferences.strings[record].values, null);
      assert.equal(setting.encode([10, 0, 10]), "[0,10]");
    } else {
      assert.deepEqual(schema.options, preferences.strings[record].values, field);
    }
  }
});

test("alerts flag only changes that could stop alarms from ringing or being heard", () => {
  const rec = (before, after) => ({ before, after });
  const c = `c_${"a".repeat(64)}`;
  const e = `e_${"a".repeat(64)}`;
  assert.equal(changeAlert({ p_alarms_paused_until: rec("0", "-1") }), "paused");
  assert.equal(changeAlert({ p_alarms_paused_until: rec("-1", "0") }), null);
  assert.equal(changeAlert({ [c]: rec('{"selected":true}', '{"selected":false}') }), "calendar_unwatched");
  assert.equal(changeAlert({ [c]: rec(null, '{"overrides":{"enabled":false}}') }), "alarms_off");
  assert.equal(changeAlert({ [e]: rec(null, '{"leadTimes":[],"enabled":false}') }), "alarms_off");
  assert.equal(changeAlert({ [e]: rec('{"enabled":false}', '{"leadTimes":[5],"enabled":false}') }), null, "already off");
  assert.equal(changeAlert({ p_alarm_volume: rec(null, "20") }), "alerts_reduced");
  assert.equal(changeAlert({ p_alarm_volume: rec("10", "15") }), null, "louder than before");
  assert.equal(changeAlert({ p_alert_type: rec(null, '"vibration_only"') }), "alerts_reduced");
  assert.equal(changeAlert({ p_alert_type: rec('"visual_only"', '"vibration_only"') }), null);
  assert.equal(changeAlert({ p_vibration_enabled: rec(null, "false") }, { p_alert_type: '"vibration_only"' }), "alerts_reduced");
  assert.equal(changeAlert({ p_vibration_enabled: rec(null, "false") }, { p_alert_type: null }), null, "sound still plays");
});

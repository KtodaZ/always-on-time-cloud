"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const skip = process.env.FIRESTORE_EMULATOR_HOST
  ? false
  : "requires Firestore emulator";
test(
  "rule previews are account/payload-bound, single use, expiring and atomic with activity/undo",
  { skip },
  async () => {
    const { initializeApp, deleteApp } = require("firebase-admin/app");
    const { getFirestore } = require("firebase-admin/firestore");
    const { createToolContext } = require("../assistant-tool-context");
    const { TOOLS } = require("../assistant-tools");
    const { refs, deleteConnectorData } = require("../assistant-data");
    const app = initializeApp(
        { projectId: "demo-account-sync" },
        `rules-${Date.now()}`,
      ),
      db = getFirestore(app);
    const uid = `rules-${Date.now()}`;
    let now = Date.now();
    const ctx = createToolContext({
      db,
      uid,
      grant: { grantId: "test", clientName: "Claude" },
      now: () => now,
      logger: {},
      origin: "https://example.com",
    });
    ctx.pushAllowed = async () => true;
    const call = (name, args = {}) =>
      TOOLS.find((t) => t.name === name).handler(ctx, args);
    const payload = {
      timeZone: "UTC",
      device: "Test phone",
      calendars: [
        {
          key: `c_${"c".repeat(64)}`,
          name: "Work",
          watched: true,
          leadTimes: [10],
        },
      ],
      events: [
        {
          eventKey: `e_${"e".repeat(64)}`,
          seriesKey: `s_${"a".repeat(64)}`,
          calendarKey: `c_${"c".repeat(64)}`,
          title: "Lunch",
          start: now + 3600000,
          end: now + 7200000,
          alarms: [
            {
              kind: "lead",
              minutes: 10,
              at: now + 3000000,
              source: "calendar",
              status: "on",
            },
          ],
        },
      ],
    };
    const args = {
      operation: "create",
      rule: {
        when: [{ type: "title_contains", text: "Lunch" }],
        then: { type: "dont_ring" },
      },
    };
    try {
      await refs.account(db, uid).set({ active: true, schemaVersion: 1 });
      await refs
        .snapshots(db, uid)
        .doc("phone")
        .set({
          publishedAt: new Date(now),
          payload: JSON.stringify(payload),
          schemaVersion: 1,
        });
      const p = await call("preview_rule", args);
      assert.equal(p.data.silencedCount, 1);
      assert.equal((await refs.values(db, uid).get()).size, 0);
      const previewRef = refs
        .account(db, uid)
        .collection("assistantRulePreviews")
        .doc(p.data.previewId);
      const a = await call("apply_rule", { previewId: p.data.previewId });
      assert.equal(a.data.changed, true);
      assert.equal(a.data.alert, "alarms_off");
      const stored = JSON.parse(
        (await refs.values(db, uid).doc(p.data.ruleId).get()).data().payload,
      );
      assert.equal(stored.createdBy, "assistant");
      assert.equal(stored.assistantName, "Claude");
      const activity = (
        await refs.activity(db, uid).doc(a.data.changeId).get()
      ).data();
      assert.match(
        activity.summary,
        /Claude added a rule: When an event has Lunch in the title → don't ring · 1 event/,
      );
      assert.ok((await previewRef.get()).data().usedAt);
      await assert.rejects(
        call("apply_rule", { previewId: p.data.previewId }),
        /already used/,
      );
      assert.equal((await call("list_rules")).data.rules.length, 1);
      const explainedPayload = structuredClone(payload);
      explainedPayload.events[0].alarms = [];
      explainedPayload.events[0].silencedByRules = [p.data.ruleId.slice(2)];
      await refs.snapshots(db,uid).doc("phone").update({payload:JSON.stringify(explainedPayload)});
      const explanation = await call("explain_alarm",{event:payload.events[0].eventKey});
      assert.match(explanation.text,/Silenced by rules:.*When an event has Lunch in the title → don't ring/);
      assert.deepEqual(explanation.data.event.silencedByRules,[p.data.ruleId.slice(2)]);
      await refs.snapshots(db,uid).doc("phone").update({payload:JSON.stringify(payload)});
      await call("undo", { changeId: a.data.changeId });
      assert.equal(
        (await refs.values(db, uid).doc(p.data.ruleId).get()).exists,
        false,
      );
      const p2 = await call("preview_rule", args);
      now += 15 * 60000;
      await assert.rejects(
        call("apply_rule", { previewId: p2.data.previewId }),
        /expired/,
      );
      const p3 = await call("preview_rule", args);
      const ref3 = refs
        .account(db, uid)
        .collection("assistantRulePreviews")
        .doc(p3.data.previewId);
      await ref3.update({ payload: "null" });
      await assert.rejects(
        call("apply_rule", { previewId: p3.data.previewId }),
        /mismatched/,
      );
      const p4 = await call("preview_rule", args);
      ctx.grant.grantId = "other";
      await assert.rejects(
        call("apply_rule", { previewId: p4.data.previewId }),
        /mismatched/,
      );
      ctx.grant.grantId = "test";
      const p5 = await call("preview_rule", args);
      await refs
        .values(db, uid)
        .doc("p_skip_event_keywords")
        .set({ payload: '"[\\"Lunch\\"]"' });
      await assert.rejects(
        call("apply_rule", { previewId: p5.data.previewId }),
        /Settings changed/,
      );
      await refs.values(db, uid).doc("p_skip_event_keywords").delete();
      const p6 = await call("preview_rule", args);
      const raced = await Promise.allSettled([
        call("apply_rule", { previewId: p6.data.previewId }),
        call("apply_rule", { previewId: p6.data.previewId }),
      ]);
      assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
      let deletedChange;
      for (const operation of ["disable", "enable", "edit", "delete"]) {
        const p = await call("preview_rule", {
          operation,
          ruleId: p6.data.ruleId,
          ...(operation === "edit"
            ? {
                rule: {
                  when: [{ type: "title_contains", text: "Meeting" }],
                  then: {
                    type: "add_ring",
                    minutes: 45,
                    label: "Prepare",
                    style: "notification",
                  },
                },
              }
            : {}),
        });
        const applied = await call("apply_rule", {
          previewId: p.data.previewId,
        });
        if (operation === "delete") deletedChange = applied.data.changeId;
      }
      assert.equal(
        (await refs.values(db, uid).doc(p6.data.ruleId).get()).exists,
        false,
      );
      const { valuesSince } = require("../assistant-device-api");
      const delivered = await valuesSince(db, uid, 0);
      assert.ok(
        delivered.values.some(
          (v) => v.id === p6.data.ruleId && v.payload === "null",
        ),
      );
      const other = createToolContext({
        db,
        uid: uid + "-other",
        grant: ctx.grant,
        now: () => now,
        logger: {},
      });
      await assert.rejects(
        TOOLS.find((t) => t.name === "apply_rule").handler(other, {
          previewId: p6.data.previewId,
        }),
        /missing/,
      );
      const stale = await call("preview_rule", args);
      await refs
        .snapshots(db, uid)
        .doc("phone")
        .update({ publishedAt: new Date(now + 1) });
      // A newer snapshot (any scheduling pass publishes one) doesn't void the preview.
      await call("apply_rule", { previewId: stale.data.previewId });
      assert.notEqual(
        (
          await refs
            .account(db, uid)
            .collection("assistantRulePreviews")
            .doc(stale.data.previewId)
            .get()
        ).data().usedAt,
        undefined,
      );
      // Per-ring metadata is written next to lead-time lists on all supported scopes.
      const ringOptions = { 45: { label: "Prepare", style: "notification" } };
      for (const [tool, args, id] of [
        [
          "set_event_alarms",
          { event: payload.events[0].eventKey },
          payload.events[0].eventKey,
        ],
        [
          "set_series_alarms",
          { event: payload.events[0].seriesKey },
          payload.events[0].seriesKey,
        ],
        [
          "set_calendar",
          { calendar: payload.events[0].calendarKey },
          payload.events[0].calendarKey,
        ],
      ]) {
        if (tool === "set_series_alarms") {
          payload.events[0].recurring = true;
          await refs
            .snapshots(db, uid)
            .doc("phone")
            .update({ payload: JSON.stringify(payload) });
        }
        await call(tool, { ...args, leadTimes: [45], ringOptions });
        const v = JSON.parse(
          (await refs.values(db, uid).doc(id).get()).data().payload,
        );
        assert.deepEqual(
          (tool === "set_calendar" ? v.overrides : v).ringOptions,
          ringOptions,
        );
      }
      await call("update_settings", {
        settings: { defaultLeadTimes: [45], defaultRingOptions: ringOptions },
      });
      assert.deepEqual(
        JSON.parse(
          JSON.parse(
            (
              await refs.values(db, uid).doc("p_default_ring_options").get()
            ).data().payload,
          ),
        ),
        ringOptions,
      );
      await call("update_settings", { settings: { defaultLeadTimes: [10] } });
      assert.equal(
        JSON.parse(
          (
            await refs.values(db, uid).doc("p_default_ring_options").get()
          ).data().payload,
        ),
        "{}",
      );
      await call("update_settings", { settings: { defaultRingOptions: null } });
      assert.equal(
        (await refs.values(db, uid).doc("p_default_ring_options").get()).data()
          .payload,
        "null",
      );
      await assert.rejects(
        call("set_event_alarms", {
          event: payload.events[0].eventKey,
          leadTimes: [45],
          ringOptions: { 45: { label: "x".repeat(41) } },
        }),
        /label/,
      );
      await assert.rejects(
        call("apply_rule", {
          previewId: "pr_00000000-0000-0000-0000-000000000000",
        }),
        /missing/,
      );
      // Count limit applies to enabled and disabled rules alike.
      const { randomUUID } = require("node:crypto");
      const batch = db.batch();
      for (let i = 0; i < 30; i++)
        batch.set(refs.values(db, uid).doc(`r_${randomUUID()}`), {
          payload: JSON.stringify({
            enabled: false,
            order: i,
            when: [{ type: "title_contains", text: "Lunch" }],
            then: { type: "dont_ring" },
            createdBy: "user",
            createdAt: 0,
          }),
        });
      await batch.commit();
      await assert.rejects(call("preview_rule", args), /30 rules/);
      await assert.rejects(
        call("undo", { changeId: deletedChange }),
        /exceed 30 rules/,
      );
      await deleteConnectorData(db, uid);
      assert.equal(
        (await refs.account(db, uid).collection("assistantRulePreviews").get())
          .size,
        0,
      );
    } finally {
      await db.recursiveDelete(refs.account(db, uid));
      await deleteApp(app);
    }
  },
);

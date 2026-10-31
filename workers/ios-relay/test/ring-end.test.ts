// Ring-end wakes (IOS-BUG-55): an AlarmKit alarm nobody answers keeps alerting until app code stops
// it, so the relay wakes the phone once each armed trigger's ring time has run out.
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { addMissingColumns } from "../src/shard";
import { RING_END_MARGIN_MS, RING_END_WINDOW_MS, dueRingEnds, planPush, ringEndsCoveredByPush, wakeTimes, type InstallState } from "../src/schedule";
import { DAY, FRESHNESS, MINUTE, POLLING, harness, type Harness } from "./helpers";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const RING = { ...FRESHNESS, ringSeconds: 300 };
const RING_POLLING = { ...POLLING, ringSeconds: 300 };

async function registered(freshness: Record<string, unknown> = RING, extra: Record<string, unknown> = {}): Promise<Harness> {
  const h = await harness();
  expect((await h.register({ freshness, ...extra })).status).toBe(201);
  return h;
}

/** Advances the fake clock to `untilMs` in `stepMs` steps, running the shard alarm whenever it is due. */
async function runUntil(h: Harness, untilMs: number, stepMs = 10 * 1000): Promise<void> {
  while (h.now() < untilMs) {
    h.setNow(Math.min(untilMs, h.now() + stepMs));
    await h.tick();
  }
}

function ringEnds(h: Harness): number[] {
  return h.apns.filter((call) => call.body.aot.kind === "ringEnd").map((call) => call.body.aot.at);
}

describe("ring-end wakes", () => {
  it("wake the phone ring time + margin after an armed trigger, once, at priority 10", async () => {
    const h = await registered();
    const trigger = h.now() + 30 * MINUTE;
    expect((await h.putAlarms([{ id: "a", triggerAtMs: trigger }])).status).toBe(204);
    await runUntil(h, trigger + 20 * MINUTE);
    const wake = trigger + 300 * 1000 + RING_END_MARGIN_MS;
    expect(ringEnds(h)).toEqual([wake]);
    const call = h.apns.find((candidate) => candidate.body.aot.kind === "ringEnd");
    expect(call?.headers["apns-priority"]).toBe("10");
    expect(call?.headers["apns-collapse-id"]).toBe("aot-sync");
    // Prechecks still ran before the trigger.
    expect(h.kinds().filter((kind) => kind === "precheck")).toHaveLength(2);
  });

  it("survive the snapshot that drops the passed trigger, and stop after it is covered", async () => {
    const h = await registered();
    const trigger = h.now() + 10 * MINUTE;
    await h.putAlarms([{ id: "a", triggerAtMs: trigger }]);
    h.setNow(trigger + MINUTE);
    // The phone's next snapshot carries only future triggers.
    expect((await h.putAlarms([])).status).toBe(204);
    await runUntil(h, trigger + 10 * MINUTE);
    expect(ringEnds(h)).toEqual([trigger + 300_000 + RING_END_MARGIN_MS]);
    // Covered: the next snapshot may drop it.
    expect((await h.putAlarms([])).status).toBe(204);
    expect(await h.sql(await h.shard(), "SELECT alarm_key FROM alarms WHERE install_id = ?", h.installId)).toEqual([]);
  });

  it("are never sent for a trigger moved or cancelled before it rang", async () => {
    const h = await registered();
    const trigger = h.now() + 10 * MINUTE;
    await h.putAlarms([{ id: "old", triggerAtMs: trigger }]);
    h.advance(5 * MINUTE);
    const moved = trigger + 60 * MINUTE;
    await h.putAlarms([{ id: "new", triggerAtMs: moved }]);
    await runUntil(h, trigger + 20 * MINUTE);
    expect(ringEnds(h)).toEqual([]);
    await runUntil(h, moved + 10 * MINUTE);
    expect(ringEnds(h)).toEqual([moved + 300_000 + RING_END_MARGIN_MS]);
  });

  it("are not sent for 'until dismissed', without a ring time, or for an unarmed trigger", async () => {
    for (const [freshness, armed] of [[{ ...FRESHNESS, ringSeconds: 0 }, true], [FRESHNESS, true], [RING, false]] as const) {
      const h = await registered(freshness);
      const trigger = h.now() + 10 * MINUTE;
      await h.api("PUT", `/v2/installations/${h.installId}/alarms`, { body: { alarms: [{ id: "a", triggerAtMs: trigger, armed }] } });
      await runUntil(h, trigger + 20 * MINUTE, MINUTE);
      expect(ringEnds(h)).toEqual([]);
      vi.restoreAllMocks();
    }
  });

  it("are not held back by the 2-minute coalescing", async () => {
    const h = await registered();
    const trigger = h.now() + 10 * MINUTE;
    await h.putAlarms([{ id: "a", triggerAtMs: trigger }]);
    await runUntil(h, trigger, MINUTE);
    // A calendar change 10 s before the ring ends: its push does not cover the ring end.
    h.setNow(trigger + 290_000);
    await h.putGoogle(`chan-${h.installId}`, h.now() + 6 * DAY);
    await h.google(`chan-${h.installId}`);
    await h.tick();
    await runUntil(h, trigger + 10 * MINUTE, 5 * 1000);
    expect(ringEnds(h)).toEqual([trigger + 300_000 + RING_END_MARGIN_MS]);
  });

  it("are covered by the meeting-window prechecks of a polling install", async () => {
    const h = await registered(RING_POLLING);
    // A 10-minute alarm and the meeting's at-start alarm: the at-start alarm's prechecks run while
    // the first one rings, and the first one after its ring ended is its ring-end wake too.
    const first = h.now() + 40 * MINUTE;
    await h.putAlarms([{ id: "lead", triggerAtMs: first }, { id: "start", triggerAtMs: first + 10 * MINUTE }]);
    await runUntil(h, first + 10 * MINUTE);
    const covering = h.apns.map((call) => call.body.aot.at).filter((at) => at >= first + 300_000 + RING_END_MARGIN_MS);
    expect(covering[0] - (first + 300_000 + RING_END_MARGIN_MS)).toBeLessThanOrEqual(10_000);
  });

  it("are not covered by a push within the margin after the ring end (iPhone clock skew)", async () => {
    const h = await registered();
    const trigger = h.now() + 10 * MINUTE;
    await h.putAlarms([{ id: "a", triggerAtMs: trigger }]);
    await runUntil(h, trigger, MINUTE);
    h.setNow(trigger + 300_000 + 5_000);
    await h.putGoogle(`chan-${h.installId}`, h.now() + 6 * DAY);
    await h.google(`chan-${h.installId}`);
    await h.tick();
    await runUntil(h, trigger + 30 * MINUTE, 5 * 1000);
    expect(h.kinds().slice(-2)).toEqual(["change", "ringEnd"]);
    expect(ringEnds(h)).toEqual([trigger + 300_000 + RING_END_MARGIN_MS]);
  });

  it("wait for an APNs failure backoff and are dropped an hour after they were due", async () => {
    const h = await registered();
    const trigger = h.now() + 10 * MINUTE;
    await h.putAlarms([{ id: "a", triggerAtMs: trigger }]);
    await runUntil(h, trigger, MINUTE);
    h.respond = () => ({ status: 503 });
    const wake = trigger + 300_000 + RING_END_MARGIN_MS;
    await runUntil(h, wake + RING_END_WINDOW_MS + 10 * MINUTE, MINUTE);
    const attempts = h.apns.filter((call) => call.body.aot.kind === "ringEnd").map((call) => (call.body.aot.at - wake) / MINUTE);
    // 1, 2, 4, 8, 16, 30 minutes of backoff, then the window closes.
    expect(attempts.length).toBeGreaterThan(3);
    expect(Math.max(...attempts)).toBeLessThan(RING_END_WINDOW_MS / MINUTE);
  });

  it("work for receipt installs, with a delivery ID", async () => {
    const h = await registered(RING, { receiptVersion: 1 });
    const trigger = h.now() + 10 * MINUTE;
    await h.putAlarms([{ id: "a", triggerAtMs: trigger }]);
    await runUntil(h, trigger + 10 * MINUTE);
    const call = h.apns.find((candidate) => candidate.body.aot.kind === "ringEnd");
    expect(call?.body.aot.at).toBe(trigger + 300_000 + RING_END_MARGIN_MS);
    expect((call?.body.aot as unknown as { deliveryId?: string }).deliveryId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("follow a ring time changed by an update", async () => {
    const h = await registered();
    const trigger = h.now() + 10 * MINUTE;
    await h.putAlarms([{ id: "a", triggerAtMs: trigger }]);
    expect((await h.update({ freshness: { ...FRESHNESS, ringSeconds: 60 } })).status).toBe(204);
    await runUntil(h, trigger + 10 * MINUTE);
    expect(ringEnds(h)).toEqual([trigger + 60_000 + RING_END_MARGIN_MS]);
  });

  it("reject an invalid ring time", async () => {
    const h = await harness();
    for (const ringSeconds of [-1, 86401, 1.5, "300", null]) {
      expect((await h.register({ freshness: { ...FRESHNESS, ringSeconds } })).status).toBe(400);
    }
    expect((await h.register({ freshness: { ...FRESHNESS, ringSeconds: 86400 } })).status).toBe(201);
  });
});

describe("schema", () => {
  it("adds the ring-end columns to a shard created before them", async () => {
    const h = await registered();
    const columns = await runInDurableObject(await h.shard(), (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("ALTER TABLE alarms DROP COLUMN ring_end_sent");
      sql.exec("ALTER TABLE alarms DROP COLUMN armed");
      sql.exec("ALTER TABLE installs DROP COLUMN ring_seconds");
      addMissingColumns(sql);
      addMissingColumns(sql);
      const names = (table: string) => sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).toArray().map((row) => row.name);
      return { alarms: names("alarms"), installs: names("installs") };
    });
    expect(columns.alarms).toEqual(expect.arrayContaining(["armed", "ring_end_sent"]));
    expect(columns.installs).toContain("ring_seconds");
  });
});

describe("ring-end planning", () => {
  const NOW = Date.parse("2030-10-07T16:00:00.000Z");
  const base = (overrides: Partial<InstallState> = {}): InstallState => ({
    enabled: true,
    freshness: { polling: false, activeHours: { start: "06:00", end: "23:00" }, timeZone: "America/Los_Angeles", ringSeconds: 300 },
    createdAt: NOW - DAY,
    lastPushAt: null,
    lastSyncAt: null,
    pendingChangeAt: null,
    pendingChangeProvider: null,
    claimedAt: null,
    retryAfter: null,
    alarms: [{ key: "a", triggerAt: NOW, sentT20: NOW - 20 * MINUTE, sentT8: NOW - 8 * MINUTE }],
    ...overrides,
  });
  const wake = NOW + 300_000 + RING_END_MARGIN_MS;

  it("is due from ring end + margin and wakes the shard then", () => {
    expect(planPush(base(), [], wake - 1)).toBeNull();
    expect(planPush(base(), [], wake)?.kind).toBe("ringEnd");
    expect(wakeTimes(base(), [], NOW + MINUTE)).toEqual({ next: wake, priority: wake });
  });

  it("ignores coalescing but not an in-flight push or a failure backoff", () => {
    expect(planPush(base({ lastPushAt: wake - 10_000 }), [], wake)?.kind).toBe("ringEnd");
    expect(planPush(base({ claimedAt: wake - 10_000 }), [], wake)).toBeNull();
    expect(planPush(base({ retryAfter: wake + MINUTE }), [], wake)).toBeNull();
    expect(wakeTimes(base({ retryAfter: wake + MINUTE }), [], wake).priority).toBe(wake + MINUTE);
  });

  it("counts any push as the wake only from ring end + margin (an iPhone clock running behind)", () => {
    expect(ringEndsCoveredByPush(base(), wake - 1)).toEqual([]);
    expect(ringEndsCoveredByPush(base(), wake)).toEqual(["a"]);
    expect(ringEndsCoveredByPush(base({ freshness: { ...base().freshness, ringSeconds: 0 } }), wake)).toEqual([]);
  });

  it("is not due once covered, after its window, or for a disabled or ineligible install", () => {
    const covered = base({ alarms: [{ key: "a", triggerAt: NOW, sentT20: 1, sentT8: 1, ringEndSentAt: wake }] });
    expect(dueRingEnds(covered, wake + 1)).toEqual([]);
    expect(dueRingEnds(base(), wake + RING_END_WINDOW_MS)).toEqual([]);
    expect(planPush(base({ enabled: false }), [], wake)).toBeNull();
    expect(planPush(base({ receipt: { version: 1, generation: 0, snapshotRevision: 0, nextRefreshAt: null, lastWakeAt: null,
      eligible: false, outstanding: null } }), [], wake)).toBeNull();
  });
});

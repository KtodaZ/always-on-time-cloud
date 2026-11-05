// Notice-end wakes: nothing runs on the phone at a meeting's start, so the relay wakes it once the
// meeting its upcoming notice announces has started, and that run takes the notice down.
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { addMissingColumns } from "../src/shard";
import { NOTICE_END_WINDOW_MS, RING_END_MARGIN_MS, isNoticeEndDue, noticeEndCoveredByPush, planPush, wakeTimes, type InstallState } from "../src/schedule";
import { DAY, FRESHNESS, MINUTE, POLLING, harness, type Harness } from "./helpers";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function registered(extra: Record<string, unknown> = {}): Promise<Harness> {
  const h = await harness();
  expect((await h.register(extra)).status).toBe(201);
  return h;
}

function putSnapshot(h: Harness, body: Record<string, unknown>): Promise<Response> {
  return h.api("PUT", `/v2/installations/${h.installId}/alarms`, { body: { alarms: [], ...body } });
}

function postReceipt(h: Harness, revision: number, extra: Record<string, unknown> = {}): Promise<Response> {
  return h.api("POST", `/v2/installations/${h.installId}/synced`, { body: {
    receiptVersion: 1, syncedAtMs: h.now(), snapshotRevision: revision, calendarVerified: true, alarmsReconciled: true,
    alarms: [], nextRefreshAtMs: h.now() + DAY, ...extra,
  } });
}

async function runUntil(h: Harness, untilMs: number, stepMs = 10 * 1000): Promise<void> {
  while (h.now() < untilMs) {
    h.setNow(Math.min(untilMs, h.now() + stepMs));
    await h.tick();
  }
}

function noticeEnds(h: Harness): number[] {
  return h.apns.filter((call) => call.body.aot.kind === "noticeEnd").map((call) => call.body.aot.at);
}

describe("notice-end wakes", () => {
  it("wake the phone at the start + margin, once, at priority 10", async () => {
    const h = await registered();
    const start = h.now() + 30 * MINUTE;
    expect((await putSnapshot(h, { noticeEndsAtMs: start })).status).toBe(204);
    expect(await h.alarmAt()).toBe(start + RING_END_MARGIN_MS);
    await runUntil(h, start + 3 * 60 * MINUTE, MINUTE / 6);
    expect(noticeEnds(h)).toEqual([start + RING_END_MARGIN_MS]);
    const call = h.apns.find((candidate) => candidate.body.aot.kind === "noticeEnd");
    expect(call?.headers["apns-priority"]).toBe("10");
    expect(call?.headers["apns-collapse-id"]).toBe("aot-sync");
  });

  it("do not depend on an alarm still being in the snapshot", async () => {
    const h = await registered();
    const start = h.now() + 30 * MINUTE;
    await putSnapshot(h, { alarms: [{ id: "lead", triggerAtMs: start - 10 * MINUTE }], noticeEndsAtMs: start });
    // The 10-minute alarm is dismissed: its trigger leaves the snapshot, the meeting has not started.
    h.setNow(start - 5 * MINUTE);
    await putSnapshot(h, { alarms: [], noticeEndsAtMs: start });
    await runUntil(h, start + 5 * MINUTE);
    expect(noticeEnds(h)).toEqual([start + RING_END_MARGIN_MS]);
  });

  it("are not limited by active hours", async () => {
    const h = await registered({ freshness: { ...FRESHNESS, activeHours: { start: "03:00", end: "03:01" } } });
    const start = h.now() + 30 * MINUTE;
    await putSnapshot(h, { noticeEndsAtMs: start });
    await runUntil(h, start + 5 * MINUTE);
    expect(noticeEnds(h)).toEqual([start + RING_END_MARGIN_MS]);
  });

  it("are never sent for a snapshot without the field (older clients), or after a null", async () => {
    const h = await registered();
    expect((await putSnapshot(h, {})).status).toBe(204);
    const start = h.now() + 30 * MINUTE;
    await putSnapshot(h, { noticeEndsAtMs: start });
    await putSnapshot(h, { noticeEndsAtMs: null });
    expect((await h.row())?.notice_ends_at).toBeNull();
    await runUntil(h, start + 5 * MINUTE, MINUTE);
    expect(h.apns).toEqual([]);
  });

  it("keep the stored value when a later snapshot leaves the field out", async () => {
    const h = await registered();
    const start = h.now() + 30 * MINUTE;
    await putSnapshot(h, { noticeEndsAtMs: start });
    await putSnapshot(h, { alarms: [] });
    expect((await h.row())?.notice_ends_at).toBe(start);
    await runUntil(h, start + 5 * MINUTE);
    expect(noticeEnds(h)).toEqual([start + RING_END_MARGIN_MS]);
  });

  it("follow a changed value, and a value re-sent after its wake sends nothing", async () => {
    const h = await registered();
    const start = h.now() + 30 * MINUTE;
    await putSnapshot(h, { noticeEndsAtMs: start });
    const moved = start + 60 * MINUTE;
    await putSnapshot(h, { noticeEndsAtMs: moved });
    await runUntil(h, moved + MINUTE);
    expect(noticeEnds(h)).toEqual([moved + RING_END_MARGIN_MS]);
    // A phone whose clock runs behind still announces the meeting and sends the value again.
    await putSnapshot(h, { noticeEndsAtMs: moved });
    await runUntil(h, moved + 10 * MINUTE);
    expect(noticeEnds(h)).toEqual([moved + RING_END_MARGIN_MS]);
  });

  it("respect the 2-minute coalescing", async () => {
    const h = await registered();
    await h.putGoogle(`chan-${h.installId}`, h.now() + 6 * DAY);
    const start = h.now() + 30 * MINUTE;
    await putSnapshot(h, { noticeEndsAtMs: start });
    // A calendar change 10 s before the wake is due: its push is too soon to cover it.
    h.setNow(start + RING_END_MARGIN_MS - 10_000);
    await h.google(`chan-${h.installId}`);
    await h.tick();
    await runUntil(h, start + 5 * MINUTE, 5 * 1000);
    expect(h.kinds().slice(-2)).toEqual(["change", "noticeEnd"]);
    expect(noticeEnds(h)).toEqual([start + RING_END_MARGIN_MS - 10_000 + 2 * MINUTE]);
  });

  it("are covered by any accepted push at or after the due time", async () => {
    const h = await registered();
    await h.putGoogle(`chan-${h.installId}`, h.now() + 6 * DAY);
    const start = h.now() + 30 * MINUTE;
    await putSnapshot(h, { noticeEndsAtMs: start });
    h.setNow(start + RING_END_MARGIN_MS);
    await h.google(`chan-${h.installId}`);
    await h.tick();
    expect(h.kinds().slice(-1)).toEqual(["change"]);
    expect((await h.row())?.notice_end_sent).toBe(start + RING_END_MARGIN_MS);
    await runUntil(h, start + 10 * MINUTE);
    expect(noticeEnds(h)).toEqual([]);
  });

  it("wait for an APNs failure backoff and are dropped an hour after they were due", async () => {
    const h = await registered();
    const start = h.now() + 10 * MINUTE;
    await putSnapshot(h, { noticeEndsAtMs: start });
    h.respond = () => ({ status: 503 });
    const wake = start + RING_END_MARGIN_MS;
    await runUntil(h, wake + NOTICE_END_WINDOW_MS + 10 * MINUTE, MINUTE);
    const attempts = h.apns.filter((call) => call.body.aot.kind === "noticeEnd").map((call) => (call.body.aot.at - wake) / MINUTE);
    expect(attempts.length).toBeGreaterThan(3);
    expect(Math.max(...attempts)).toBeLessThan(NOTICE_END_WINDOW_MS / MINUTE);
  });

  it("work for a phone whose snapshot arrives after the start (a clock running behind)", async () => {
    const h = await registered();
    const start = h.now() - 5_000;
    expect((await putSnapshot(h, { noticeEndsAtMs: start })).status).toBe(204);
    await runUntil(h, h.now() + MINUTE, 5 * 1000);
    expect(noticeEnds(h)).toEqual([start + RING_END_MARGIN_MS]);
  });

  it("reject an invalid value on both paths and read one beyond the horizon as no wake", async () => {
    const h = await registered({ receiptVersion: 1 });
    for (const noticeEndsAtMs of ["soon", -1, 1.5, true]) {
      expect((await putSnapshot(h, { noticeEndsAtMs })).status).toBe(400);
      expect((await postReceipt(h, 1, { noticeEndsAtMs })).status).toBe(400);
    }
    expect((await putSnapshot(h, { noticeEndsAtMs: h.now() + 91 * DAY })).status).toBe(204);
    expect((await h.row())?.notice_ends_at).toBeNull();
  });

  it("forget the value a day after it passed, as alarm triggers", async () => {
    const h = await registered();
    const start = h.now() + 10 * MINUTE;
    await putSnapshot(h, { noticeEndsAtMs: start });
    await runUntil(h, start + MINUTE);
    expect((await h.row())?.notice_ends_at).toBe(start);
    h.setNow(start + DAY);
    await h.tick();
    const row = await h.row();
    expect(row?.notice_ends_at).toBeNull();
    expect(row?.notice_end_sent).toBeNull();
  });
});

describe("notice ends in receipts", () => {
  it("apply with a newer revision, carry a delivery ID, and are not resent", async () => {
    const h = await registered({ receiptVersion: 1 });
    const start = h.now() + 30 * MINUTE;
    expect((await postReceipt(h, 1, { noticeEndsAtMs: start })).status).toBe(204);
    await runUntil(h, start + 20 * MINUTE);
    const calls = h.apns.filter((call) => call.body.aot.kind === "noticeEnd");
    expect(calls.map((call) => call.body.aot.at)).toEqual([start + RING_END_MARGIN_MS]);
    expect((calls[0].body.aot as unknown as { deliveryId?: string }).deliveryId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("are ignored from an older revision, as its triggers are", async () => {
    const h = await registered({ receiptVersion: 1 });
    const start = h.now() + 30 * MINUTE;
    await postReceipt(h, 5, { noticeEndsAtMs: start });
    await postReceipt(h, 4, { noticeEndsAtMs: null });
    expect((await h.row())?.notice_ends_at).toBe(start);
    await postReceipt(h, 3, { noticeEndsAtMs: start + MINUTE });
    expect((await h.row())?.notice_ends_at).toBe(start);
  });

  it("read absent and null as a PUT does", async () => {
    const h = await registered({ receiptVersion: 1 });
    const start = h.now() + 30 * MINUTE;
    await postReceipt(h, 1, { noticeEndsAtMs: start });
    await postReceipt(h, 2);
    expect((await h.row())?.notice_ends_at).toBe(start);
    await postReceipt(h, 3, { noticeEndsAtMs: null });
    expect((await h.row())?.notice_ends_at).toBeNull();
  });

  it("share the value with PUT snapshots", async () => {
    const h = await registered({ receiptVersion: 1 });
    const start = h.now() + 30 * MINUTE;
    await putSnapshot(h, { noticeEndsAtMs: start });
    await postReceipt(h, 1);
    expect((await h.row())?.notice_ends_at).toBe(start);
  });
});

describe("schema", () => {
  it("adds the notice-end columns to a shard created before them", async () => {
    const h = await registered();
    const columns = await runInDurableObject(await h.shard(), (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP INDEX installs_notice_ends");
      sql.exec("ALTER TABLE installs DROP COLUMN notice_ends_at");
      sql.exec("ALTER TABLE installs DROP COLUMN notice_end_sent");
      addMissingColumns(sql);
      addMissingColumns(sql);
      return sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('installs')").toArray().map((row) => row.name);
    });
    expect(columns).toEqual(expect.arrayContaining(["notice_ends_at", "notice_end_sent"]));
  });
});

describe("notice-end planning", () => {
  const NOW = Date.parse("2030-10-07T16:00:00.000Z");
  const wake = NOW + RING_END_MARGIN_MS;
  const base = (overrides: Partial<InstallState> = {}): InstallState => ({
    enabled: true,
    freshness: { polling: false, activeHours: { start: "06:00", end: "23:00" }, timeZone: "America/Los_Angeles" },
    createdAt: NOW - DAY,
    lastPushAt: null,
    lastSyncAt: null,
    pendingChangeAt: null,
    pendingChangeProvider: null,
    claimedAt: null,
    retryAfter: null,
    alarms: [],
    noticeEndsAt: NOW,
    ...overrides,
  });
  const receiptState = (lastWakeAt: number) => ({
    version: 1 as const, generation: 0, snapshotRevision: 1, nextRefreshAt: null, lastWakeAt, eligible: true, outstanding: null,
  });

  it("is due from the start + margin, and only the shard's next wake counts it", () => {
    expect(planPush(base(), [], wake - 1)).toBeNull();
    expect(planPush(base(), [], wake)?.kind).toBe("noticeEnd");
    expect(wakeTimes(base(), [], NOW - MINUTE)).toEqual({ next: wake, priority: null });
    expect(wakeTimes(base({ noticeEndsAt: null }), [], NOW - MINUTE)).toEqual({ next: null, priority: null });
    expect(wakeTimes(base({ noticeEndsAt: undefined }), [], NOW - MINUTE)).toEqual({ next: null, priority: null });
  });

  it("waits for coalescing, an in-flight push and a failure backoff", () => {
    expect(planPush(base({ lastPushAt: wake - 10_000 }), [], wake)).toBeNull();
    expect(wakeTimes(base({ lastPushAt: wake - 10_000 }), [], wake).next).toBe(wake - 10_000 + 2 * MINUTE);
    expect(planPush(base({ claimedAt: wake - 10_000 }), [], wake)).toBeNull();
    expect(planPush(base({ retryAfter: wake + MINUTE }), [], wake)).toBeNull();
  });

  it("counts any push as the wake only from the start + margin (an iPhone clock running behind)", () => {
    expect(noticeEndCoveredByPush(base(), wake - 1)).toBe(false);
    expect(noticeEndCoveredByPush(base(), wake)).toBe(true);
  });

  it("is not due once covered, after its window, or for a disabled or ineligible install", () => {
    expect(isNoticeEndDue(base({ noticeEndSentAt: wake }), wake + 1)).toBe(false);
    expect(isNoticeEndDue(base(), wake + NOTICE_END_WINDOW_MS)).toBe(false);
    expect(wakeTimes(base(), [], wake + NOTICE_END_WINDOW_MS).next).toBeNull();
    expect(planPush(base({ enabled: false }), [], wake)).toBeNull();
    expect(planPush(base({ receipt: { ...receiptState(wake - DAY), eligible: false } }), [], wake)).toBeNull();
  });

  it("ranks below the kinds that also cover it, and above a priority-5 heartbeat", () => {
    const pending = { pendingChangeAt: wake - 1 };
    expect(planPush(base(pending), [], wake)?.kind).toBe("change");
    const renewal = { key: "k", provider: "google" as const, expiresAt: wake + DAY, renewDueAt: wake - 1, renewalRequestedAt: null };
    expect(planPush(base(), [renewal], wake)?.kind).toBe("renew");
    const polling = { ...POLLING, activeHours: { start: "00:00", end: "23:59" } };
    expect(planPush(base({ freshness: polling, noticeEndsAt: null, createdAt: wake - 2 * 60 * MINUTE }), [], wake)?.kind).toBe("heartbeat");
    expect(planPush(base({ freshness: polling, createdAt: wake - 2 * 60 * MINUTE }), [], wake)?.kind).toBe("noticeEnd");
    const receipt = { receipt: { ...receiptState(wake - MINUTE) }, freshness: polling, lastSyncAt: wake - 2 * 60 * MINUTE, createdAt: wake - DAY };
    expect(planPush(base({ ...receipt, lastPushAt: null }), [], wake)?.kind).toBe("noticeEnd");
    expect(planPush(base({ ...receipt, lastPushAt: null }), [], wake)?.burst).toBe(false);
  });

  it("wait for a ring end due soon after, so an alarm at the start costs one push", async () => {
    const h = await registered({ freshness: { ...FRESHNESS, ringSeconds: 60 } });
    const start = h.now() + 30 * MINUTE;
    expect((await putSnapshot(h, { alarms: [{ id: "a", triggerAtMs: start }], noticeEndsAtMs: start })).status).toBe(204);
    await runUntil(h, start + 10 * MINUTE);
    expect(noticeEnds(h)).toEqual([]);
    const ringEnds = h.apns.filter((call) => call.body.aot.kind === "ringEnd");
    expect(ringEnds.map((call) => call.body.aot.at)).toEqual([start + 60 * 1000 + RING_END_MARGIN_MS]);
    expect(h.apns.filter((call) => call.body.aot.at > start)).toHaveLength(1);
  });

  it("do not wait for a ring end long after, or one before the start", async () => {
    const h = await registered({ freshness: { ...FRESHNESS, ringSeconds: 600 } });
    const start = h.now() + 30 * MINUTE;
    expect((await putSnapshot(h, { alarms: [{ id: "a", triggerAtMs: start }], noticeEndsAtMs: start })).status).toBe(204);
    await runUntil(h, start + 2 * MINUTE);
    expect(noticeEnds(h)).toEqual([start + RING_END_MARGIN_MS]);
  });
});

import { describe, expect, it } from "vitest";

import {
  failureBackoffMs,
  isWithinActiveHours,
  nextActiveTime,
  planPush,
  stagesSatisfiedByPush,
  wakeTimes,
  type InstallState,
  type SubscriptionState,
} from "../src/schedule";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// 09:00 in Los Angeles.
const NOW = Date.parse("2030-10-07T16:00:00.000Z");

function install(overrides: Partial<InstallState> = {}, polling = false): InstallState {
  return {
    enabled: true,
    freshness: { polling, activeHours: { start: "06:00", end: "23:00" }, timeZone: "America/Los_Angeles" },
    createdAt: NOW - 10 * HOUR,
    lastPushAt: null,
    lastSyncAt: null,
    pendingChangeAt: null,
    pendingChangeProvider: null,
    claimedAt: null,
    retryAfter: null,
    alarms: [],
    ...overrides,
  };
}

const alarm = (triggerAt: number, sent: { t20?: number; t8?: number } = {}) => ({ key: `k${triggerAt}`, triggerAt, sentT20: sent.t20 ?? null, sentT8: sent.t8 ?? null });

/** Simulates the shard minute by minute: plans, "sends" (APNs accepts), and records push times. */
function simulate(state: InstallState, fromMs: number, toMs: number, stepMs = MINUTE): Array<{ at: number; kind: string }> {
  const sent: Array<{ at: number; kind: string }> = [];
  for (let at = fromMs; at < toMs; at += stepMs) {
    const plan = planPush(state, [], at);
    if (!plan) continue;
    for (const { key, stage } of stagesSatisfiedByPush(state, plan.kind, at)) {
      const entry = state.alarms.find((candidate) => candidate.key === key);
      if (entry && stage === "t20") entry.sentT20 = at;
      if (entry && stage === "t8") entry.sentT8 = at;
    }
    sent.push({ at, kind: plan.kind });
    state.lastPushAt = at;
    state.pendingChangeAt = null;
    if (!state.freshness.polling) {
      for (const entry of state.alarms) {
        if (at + 2 * MINUTE >= entry.triggerAt - 20 * MINUTE && at <= entry.triggerAt - 18 * MINUTE) entry.sentT20 ??= at;
        if (at + 2 * MINUTE >= entry.triggerAt - 8 * MINUTE && at <= entry.triggerAt - 6 * MINUTE) entry.sentT8 ??= at;
      }
    }
  }
  return sent;
}

describe("polling installs (EventKit calendars)", () => {
  it("send about six prechecks every 5 minutes in the half hour before an alarm", () => {
    const trigger = NOW + 2 * HOUR;
    const state = install({ lastPushAt: trigger - 40 * MINUTE, alarms: [alarm(trigger)] }, true);
    const sent = simulate(state, trigger - 31 * MINUTE, trigger + MINUTE);
    const prechecks = sent.filter((push) => push.kind === "precheck").map((push) => (trigger - push.at) / MINUTE);
    expect(prechecks).toEqual([30, 25, 20, 15, 10, 5]);
  });

  it("share pushes between overlapping meeting windows", () => {
    const first = NOW + 2 * HOUR;
    const state = install({ lastPushAt: first - 40 * MINUTE, alarms: [alarm(first), alarm(first + 10 * MINUTE)] }, true);
    const sent = simulate(state, first - 31 * MINUTE, first + 11 * MINUTE).filter((push) => push.kind === "precheck");
    // One window [T-30, T+10): a push every 5 minutes, not two streams.
    expect(sent.map((push) => (push.at - (first - 30 * MINUTE)) / MINUTE)).toEqual([0, 5, 10, 15, 20, 25, 30, 35]);
  });

  it("run meeting windows outside active hours", () => {
    const trigger = Date.parse("2030-10-08T10:30:00.000Z"); // 03:30 local
    const state = install({ lastPushAt: trigger - 2 * HOUR, alarms: [alarm(trigger)] }, true);
    expect(planPush(state, [], trigger - 30 * MINUTE)?.kind).toBe("precheck");
  });

  it("send hourly priority-5 heartbeats only inside active hours", () => {
    const state = install({ lastPushAt: NOW - 59 * MINUTE }, true);
    expect(planPush(state, [], NOW)).toBeNull();
    expect(planPush(state, [], NOW + MINUTE)?.kind).toBe("heartbeat");
    const night = Date.parse("2030-10-08T07:00:00.000Z"); // 00:00 local
    expect(planPush({ ...state, lastPushAt: night - 3 * HOUR }, [], night)).toBeNull();
    const day = simulate(install({ lastPushAt: NOW }, true), NOW, NOW + 24 * HOUR);
    // 09:00 -> 23:00 local, then 06:00 -> 09:00: hourly inside active hours only.
    expect(day.every((push) => push.kind === "heartbeat")).toBe(true);
    expect(day.length).toBe(13 + 3);
  });

  it("count the registration time and reported syncs as freshness", () => {
    expect(planPush(install({ createdAt: NOW - 30 * MINUTE }, true), [], NOW)).toBeNull();
    expect(planPush(install({ lastSyncAt: NOW - 30 * MINUTE }, true), [], NOW)).toBeNull();
    const trigger = NOW + 20 * MINUTE;
    expect(planPush(install({ lastSyncAt: NOW - 4 * MINUTE, alarms: [alarm(trigger)] }, true), [], NOW)).toBeNull();
    expect(planPush(install({ lastSyncAt: NOW - 5 * MINUTE, alarms: [alarm(trigger)] }, true), [], NOW)?.kind).toBe("precheck");
  });

  it("upgrade a heartbeat to a precheck when a meeting window opens within 2 minutes", () => {
    const state = install({ lastPushAt: NOW - 2 * HOUR, alarms: [alarm(NOW + 31 * MINUTE)] }, true);
    expect(planPush(state, [], NOW)?.kind).toBe("precheck");
  });

  it("wake at the next window point, heartbeat or renewal", () => {
    const trigger = NOW + 3 * HOUR;
    const state = install({ lastPushAt: NOW, alarms: [alarm(trigger)] }, true);
    expect(wakeTimes(state, [], NOW)).toEqual({ next: NOW + HOUR, priority: trigger - 30 * MINUTE });
    const renewal: SubscriptionState = { key: "s", provider: "google", expiresAt: NOW + DAY(), renewDueAt: NOW + 10 * MINUTE, renewalRequestedAt: null };
    expect(wakeTimes(state, [renewal], NOW).next).toBe(NOW + 10 * MINUTE);
  });
});

function DAY() {
  return 24 * HOUR;
}

describe("non-polling installs (signed-in Google/Microsoft only)", () => {
  it("send no heartbeats", () => {
    expect(planPush(install({ lastPushAt: NOW - 10 * HOUR }), [], NOW)).toBeNull();
    expect(wakeTimes(install({ lastPushAt: NOW }), [], NOW)).toEqual({ next: null, priority: null });
  });

  it("send prechecks once at T-20 and T-8, even outside active hours", () => {
    const trigger = Date.parse("2030-10-08T10:30:00.000Z"); // 03:30 local
    const sent = simulate(install({ alarms: [alarm(trigger)] }), trigger - HOUR, trigger + MINUTE);
    expect(sent.map((push) => [(trigger - push.at) / MINUTE, push.kind])).toEqual([[20, "precheck"], [8, "precheck"]]);
  });

  it("let a priority-10 push just before a stage satisfy it", () => {
    const trigger = NOW + HOUR;
    const state = install({ pendingChangeAt: trigger - 21 * MINUTE, alarms: [alarm(trigger)] });
    const sent = simulate(state, trigger - 21 * MINUTE, trigger);
    expect(sent.map((push) => [(trigger - push.at) / MINUTE, push.kind])).toEqual([[21, "change"], [8, "precheck"]]);
  });
});

describe("everyone", () => {
  it("prefers precheck > change > renew > heartbeat", () => {
    const renewal: SubscriptionState = { key: "s", provider: "microsoft", expiresAt: NOW + HOUR, renewDueAt: NOW - MINUTE, renewalRequestedAt: null };
    const base = install({ lastPushAt: NOW - 2 * HOUR, pendingChangeAt: NOW - MINUTE, pendingChangeProvider: "google" }, true);
    expect(planPush({ ...base, alarms: [alarm(NOW + 10 * MINUTE)] }, [renewal], NOW)?.kind).toBe("precheck");
    expect(planPush(base, [renewal], NOW)).toEqual({ kind: "change", provider: "google", renewalKeys: [] });
    expect(planPush({ ...base, pendingChangeAt: null }, [renewal], NOW)).toEqual({ kind: "renew", provider: "microsoft", renewalKeys: ["s"] });
    expect(planPush({ ...base, pendingChangeAt: null }, [], NOW)?.kind).toBe("heartbeat");
  });

  it("coalesce to one push per 2 minutes, honour the in-flight claim and back off after failures", () => {
    const pending = install({ pendingChangeAt: NOW, pendingChangeProvider: "google" });
    expect(planPush({ ...pending, lastPushAt: NOW - MINUTE }, [], NOW)).toBeNull();
    expect(planPush({ ...pending, lastPushAt: NOW - 2 * MINUTE }, [], NOW)?.kind).toBe("change");
    expect(planPush({ ...pending, claimedAt: NOW - MINUTE }, [], NOW)).toBeNull();
    expect(planPush({ ...pending, claimedAt: NOW - 2 * MINUTE }, [], NOW)?.kind).toBe("change");
    expect(planPush({ ...pending, retryAfter: NOW + 1 }, [], NOW)).toBeNull();
    expect(wakeTimes({ ...pending, lastPushAt: NOW - MINUTE }, [], NOW).priority).toBe(NOW + MINUTE);
    expect([1, 2, 3, 4, 5, 6, 7].map((count) => failureBackoffMs(count) / MINUTE)).toEqual([1, 2, 4, 8, 16, 30, 30]);
  });

  it("send nothing to disabled installs", () => {
    const state = install({ enabled: false, pendingChangeAt: NOW });
    expect(planPush(state, [], NOW)).toBeNull();
    expect(wakeTimes(state, [], NOW)).toEqual({ next: null, priority: null });
  });

  it("treats active hours as [start, end), across midnight and DST", () => {
    const hours = (start: string, end: string) => ({ polling: true, activeHours: { start, end }, timeZone: "America/Los_Angeles" });
    expect(isWithinActiveHours(NOW, hours("09:00", "10:00"))).toBe(true);
    expect(isWithinActiveHours(NOW, hours("08:00", "09:00"))).toBe(false);
    expect(isWithinActiveHours(NOW, hours("22:00", "09:30"))).toBe(true);
    // 2030-11-03 is the end of DST in Los Angeles; 06:00 local is 14:00Z that day.
    const beforeDst = Date.parse("2030-11-03T07:30:00.000Z"); // 00:30 PDT
    expect(new Date(nextActiveTime(beforeDst, hours("06:00", "23:00"))).toISOString()).toBe("2030-11-03T14:00:00.000Z");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { DAY, MINUTE, POLLING, harness, type Harness } from "./helpers";
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
async function ready() {
  const h = await harness();
  expect((await h.register({ receiptVersion: 1 })).status).toBe(201);
  return h;
}
async function receipt(h: Harness, deliveryId?: string, revision = 1, alarms: Array<{ id: string; triggerAtMs: number }> = []) {
  return h.api("POST", `/v2/installations/${h.installId}/synced`, { body: {
    receiptVersion: 1, syncedAtMs: h.now(), snapshotRevision: revision,
    ...(deliveryId ? { deliveryId } : {}), calendarVerified: true, alarmsReconciled: true,
    alarms: alarms.filter(a => a.triggerAtMs > h.now()), nextRefreshAtMs: h.now() + DAY,
  } });
}
async function change(h: Harness) {
  await h.putGoogle(`receipt-${h.installId}`); await h.google(`receipt-${h.installId}`); await h.tick();
}
it("quiet empty installs have a daily recovery wake", async () => {
  const h = await ready(); h.advance(DAY); await h.tick();
  expect(h.apns).toHaveLength(1);
  expect(h.apns[0].headers["apns-priority"]).toBe("10");
});
it("APNs 200 without an NSE receipt retries at 0,2,4,8,16 minutes, then stops", async () => {
  const h = await ready(); await change(h); const start = h.now();
  for (const minute of [2,4,8,16,32]) { h.setNow(start + minute * MINUTE); await h.tick(); }
  expect(h.apns.map(p => (p.body.aot.at - start) / MINUTE)).toEqual([0,2,4,8,16]);
  expect((await h.row())?.pending_change_at).not.toBeNull();
});
it("an old receipt cannot clear a newer change; duplicate receipts are safe", async () => {
  const h = await ready(); await change(h);
  const first = (h.apns[0].body.aot as unknown as { deliveryId: string }).deliveryId;
  h.advance(MINUTE); await h.google(`receipt-${h.installId}`);
  expect((await receipt(h, first)).status).toBe(204);
  expect((await h.row())?.pending_change_at).not.toBeNull();
  expect((await receipt(h, first)).status).toBe(204);
  h.advance(MINUTE); await h.tick(); expect(h.apns).toHaveLength(2);
});
it("verified receipt retires work even before APNs returns", async () => {
  const h = await ready();
  h.respond = async call => {
    const id = (call.body.aot as unknown as { deliveryId: string }).deliveryId;
    expect((await receipt(h, id)).status).toBe(204); return { status: 200 };
  };
  await change(h); expect((await h.row())?.pending_change_at).toBeNull();
  h.advance(3 * MINUTE); await h.tick(); expect(h.apns).toHaveLength(1);
});
it("published horizon deadline wakes with no uploaded triggers", async () => {
  const h = await ready();
  const body = { receiptVersion: 1, syncedAtMs: h.now(), snapshotRevision: 1,
    calendarVerified: true, alarmsReconciled: true, alarms: [], nextRefreshAtMs: h.now() + MINUTE };
  expect((await h.api("POST", `/v2/installations/${h.installId}/synced`, { body })).status).toBe(204);
  h.advance(MINUTE); await h.tick(); expect(h.apns).toHaveLength(1);
});
it("APNs backoff spanning T-20 still produces a catch-up precheck before the trigger", async () => {
  const h = await ready();
  const trigger = h.now() + 25 * MINUTE;
  await h.putAlarms([{ id: "future", triggerAtMs: trigger }]);
  h.respond = () => ({ status: 503 });
  await runFor(h, trigger - 21 * MINUTE, trigger - 10 * MINUTE);
  const failed = h.apns.length;
  expect(failed).toBeGreaterThan(0);
  h.respond = () => ({ status: 200 });
  await runFor(h, trigger - 9 * MINUTE, trigger);
  const after = h.apns.slice(failed);
  expect(after.length).toBeGreaterThan(0);
  expect(after[0].body.aot.kind).toBe("precheck");
  expect(after[0].body.aot.at).toBeLessThan(trigger);
});

/** Answers every push to this install with a verified receipt, like a healthy NSE. */
function healthyPhone(h: Harness, alarms: Array<{ id: string; triggerAtMs: number }>) {
  let revision = 100;
  h.respond = async call => {
    const id = (call.body.aot as unknown as { deliveryId: string }).deliveryId;
    revision += 1;
    expect((await receipt(h, id, revision, alarms)).status).toBe(204);
    return { status: 200 };
  };
}

async function runFor(h: Harness, fromMs: number, toMs: number) {
  for (let at = fromMs; at <= toMs; at += MINUTE) { h.setNow(at); await h.tick(); }
}

it("signed-in installs with healthy receipts get only the T-20 and T-8 stages", async () => {
  const h = await ready();
  const trigger = h.now() + 60 * MINUTE;
  const alarms = [{ id: "a", triggerAtMs: trigger }];
  healthyPhone(h, alarms); await h.putAlarms(alarms);
  await runFor(h, h.now(), trigger);
  expect(h.apns.map(p => (trigger - p.body.aot.at) / MINUTE)).toEqual([20, 8]);
});

it("an unacknowledged stage stays due until the trigger, bounded by the retry burst", async () => {
  const h = await ready();
  const trigger = h.now() + 60 * MINUTE;
  await h.putAlarms([{ id: "a", triggerAtMs: trigger }]);
  await runFor(h, h.now(), trigger + 10 * MINUTE);
  const leads = h.apns.map(p => (trigger - p.body.aot.at) / MINUTE);
  expect(leads[0]).toBe(20);
  expect(leads.every(lead => lead > 0)).toBe(true);
  expect(leads.length).toBeLessThanOrEqual(10);
});

it("polling installs with healthy receipts check about every four minutes in the meeting window", async () => {
  const h = await harness({ freshness: POLLING });
  expect((await h.register({ receiptVersion: 1 })).status).toBe(201);
  const trigger = h.now() + 90 * MINUTE;
  const alarms = [{ id: "a", triggerAtMs: trigger }];
  healthyPhone(h, alarms); await h.putAlarms(alarms);
  h.apns.length = 0;
  await runFor(h, trigger - 31 * MINUTE, trigger);
  const leads = h.apns.map(p => (trigger - p.body.aot.at) / MINUTE);
  expect(leads[0]).toBe(30);
  expect(leads.length).toBeGreaterThanOrEqual(7);
  expect(leads.length).toBeLessThanOrEqual(8);
});

it("a late receipt with an older revision still acknowledges its delivery", async () => {
  const h = await ready(); await change(h);
  const id = (h.apns[0].body.aot as unknown as { deliveryId: string }).deliveryId;
  expect((await receipt(h, undefined, 5)).status).toBe(204);
  expect((await receipt(h, id, 4)).status).toBe(204);
  expect((await h.row())?.pending_change_at).toBeNull();
});

it("a new change after an exhausted burst gets a new delivery", async () => {
  const h = await ready(); await change(h); const start = h.now();
  for (const minute of [2, 4, 8, 16, 32]) { h.setNow(start + minute * MINUTE); await h.tick(); }
  expect(h.apns).toHaveLength(5);
  await h.google(`receipt-${h.installId}`); await h.tick();
  expect(h.apns).toHaveLength(6);
  expect(h.kinds()[5]).toBe("change");
});

it("a status read reports delivery health without changing it", async () => {
  const h = await ready(); await change(h);
  const id = (h.apns[0].body.aot as unknown as { deliveryId: string }).deliveryId;
  await receipt(h, id);
  const response = await h.api("GET", `/v2/installations/${h.installId}`);
  expect(response.status).toBe(200);
  const status = await response.json() as Record<string, unknown>;
  expect(status).toMatchObject({ enabled: true, disabledReason: null, environment: "development",
    environmentVerified: true, deliveryEligible: true, unacknowledgedDeliveries: 0 });
  expect(status.lastVerifiedAtMs).toBe(h.apns[0].body.aot.at);
});

describe("APNs environment recovery", () => {
  it("one BadDeviceToken probes the other host once and remembers the working one", async () => {
    const h = await ready();
    h.respond = call => call.url.startsWith("https://api.sandbox.push.apple.com/") ? { status: 400, reason: "BadDeviceToken" } : { status: 200 };
    await change(h);
    expect(h.apns.map(p => new URL(p.url).host)).toEqual(["api.sandbox.push.apple.com", "api.push.apple.com"]);
    expect((await h.row())?.enabled).toBe(1);
    expect((await h.update({ receiptVersion: 1 })).status).toBe(204);
    h.advance(3 * MINUTE); await h.tick();
    expect(new URL(h.apns[2].url).host).toBe("api.push.apple.com");
    const status = await (await h.api("GET", `/v2/installations/${h.installId}`)).json() as Record<string, unknown>;
    expect(status).toMatchObject({ environment: "production", environmentVerified: true });
  });

  it("both hosts rejecting disables the install; 410 never probes", async () => {
    const h = await ready();
    h.respond = () => ({ status: 400, reason: "BadDeviceToken" });
    await change(h);
    expect(h.apns).toHaveLength(2);
    expect((await h.row())?.disabled_reason).toBe("apns_bad_device_token");
    const g = await ready();
    g.respond = () => ({ status: 410, reason: "Unregistered" });
    await change(g);
    expect(g.apns).toHaveLength(1);
  });
});

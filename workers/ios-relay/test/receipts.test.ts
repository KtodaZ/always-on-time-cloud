import { afterEach, expect, it, vi } from "vitest";
import { DAY, MINUTE, harness, type Harness } from "./helpers";
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
async function ready() {
  const h = await harness();
  expect((await h.register({ receiptVersion: 1 })).status).toBe(201);
  return h;
}
async function receipt(h: Harness, deliveryId?: string, revision = 1) {
  return h.api("POST", `/v2/installations/${h.installId}/synced`, { body: {
    receiptVersion: 1, syncedAtMs: h.now(), snapshotRevision: revision,
    ...(deliveryId ? { deliveryId } : {}), calendarVerified: true, alarmsReconciled: true,
    alarms: [], nextRefreshAtMs: h.now() + DAY,
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
it("signed-in installs catch up in the meeting window after backoff", async () => {
  const h = await ready();
  await h.putAlarms([{ id: "future", triggerAtMs: h.now() + 25 * MINUTE }]);
  h.respond = () => ({status: 503}); await h.tick();
  h.advance(12 * MINUTE); h.respond = () => ({status: 200}); await h.tick();
  expect(h.kinds()).toEqual(["precheck", "precheck"]);
});

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PUSH_BATCH_SIZE } from "../src/shard";
import { DAY, FRESHNESS, HOUR, MINUTE, POLLING, harness, sha256Hex, shardFor, subscriptionKey, type Harness } from "./helpers";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Advances the fake clock minute by minute, running the shard alarm whenever it is due. */
async function runFor(h: Harness, ms: number, stepMs = MINUTE): Promise<void> {
  const end = h.now() + ms;
  while (h.now() < end) {
    h.advance(stepMs);
    await h.tick();
  }
}

/** Minutes before `trigger` at which this harness's pushes of `kind` went out. */
function leads(h: Harness, trigger: number, kind = "precheck"): number[] {
  return h.apns.filter((call) => call.body.aot.kind === kind).map((call) => (trigger - call.body.aot.at) / MINUTE);
}

async function registered(freshness = FRESHNESS): Promise<Harness> {
  const h = await harness({ freshness });
  expect((await h.register()).status).toBe(201);
  return h;
}

async function changeNow(h: Harness): Promise<void> {
  const channelId = `chan-${h.installId}`;
  const key = await subscriptionKey("google", channelId);
  const rows = await h.sql(await h.shard(), "SELECT 1 FROM subscriptions WHERE sub_key = ?", key);
  if (rows.length === 0) expect((await h.putGoogle(channelId, h.now() + 6 * DAY)).status).toBe(204);
  expect((await h.google(channelId)).status).toBe(204);
}

describe("push format", () => {
  it("sends an APNs alert with the aot-sync collapse ID, priority and 24-hour expiry", async () => {
    const h = await registered();
    await changeNow(h);
    await h.tick();
    const [call] = h.apns;
    expect(call.url).toBe(`https://api.sandbox.push.apple.com/3/device/${h.apnsToken}`);
    expect(call.headers).toMatchObject({
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": "aot-sync",
      "apns-topic": "com.zombitstudios.alwaysontime",
      "apns-expiration": String(Math.floor(h.now() / 1000) + 86400),
      "content-type": "application/json",
    });
    expect(call.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(call.body).toEqual({
      aps: {
        alert: { title: "Keeping your alarms up to date", body: "Checking for calendar updates." },
        "mutable-content": 1,
        "interruption-level": "passive",
      },
      aot: { v: 1, kind: "change", provider: "google", at: h.now() },
    });
    expect(Object.keys(call.headers)).toContain("apns-id");

    expect((await h.update({ environment: "production" })).status).toBe(204);
    h.advance(3 * MINUTE);
    await changeNow(h);
    await h.tick();
    expect(h.apns[1].url).toBe(`https://api.push.apple.com/3/device/${h.apnsToken}`);
  });
});

describe("scheduling", () => {
  it("polling installs: about six prechecks in the half hour before each alarm, outside active hours too", async () => {
    const h = await registered(POLLING);
    const trigger = Date.parse("2030-10-08T10:30:00.000Z"); // 03:30 local, outside active hours
    expect((await h.putAlarms([{ id: "standup", triggerAtMs: trigger }])).status).toBe(204);
    h.setNow(trigger - 45 * MINUTE);
    await h.sql(await h.shard(), "UPDATE installs SET last_push_at = ? WHERE install_id = ?", h.now(), h.installId);
    await h.update(); // refresh wake times after the manual edit
    await runFor(h, 46 * MINUTE);
    expect(leads(h, trigger)).toEqual([30, 25, 20, 15, 10, 5]);
    expect(h.apns.every((call) => call.headers["apns-priority"] === "10")).toBe(true);
    expect(h.kinds().filter((kind) => kind !== "precheck")).toEqual([]);
  });

  it("polling installs: hourly priority-5 heartbeats inside active hours only", async () => {
    const h = await registered(POLLING);
    await runFor(h, 15 * HOUR, 5 * MINUTE); // 09:00 -> 00:00 local
    const hoursLocal = h.apns.map((call) => (new Date(call.body.aot.at).getUTCHours() + 17) % 24); // PDT
    expect(h.kinds().every((kind) => kind === "heartbeat")).toBe(true);
    expect(hoursLocal).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
    expect(h.apns.every((call) => call.headers["apns-priority"] === "5")).toBe(true);
  });

  it("non-polling installs: no heartbeats, prechecks once at T-20 and T-8", async () => {
    const h = await registered(FRESHNESS);
    const trigger = h.now() + 3 * HOUR;
    await h.putAlarms([{ id: "review", triggerAtMs: trigger }]);
    await runFor(h, 3 * HOUR + MINUTE);
    expect(leads(h, trigger)).toEqual([20, 8]);
    expect(h.kinds()).toEqual(["precheck", "precheck"]);
  });

  it("re-uploading an unchanged alarm keeps sent stages; moving it resets them", async () => {
    const h = await registered(FRESHNESS);
    const trigger = h.now() + HOUR;
    await h.putAlarms([{ id: "a", triggerAtMs: trigger }]);
    await runFor(h, 41 * MINUTE);
    expect(leads(h, trigger)).toEqual([20]);
    await h.putAlarms([{ id: "a", triggerAtMs: trigger }]);
    await runFor(h, MINUTE);
    expect(h.apns).toHaveLength(1);
    const moved = trigger + 2 * MINUTE;
    await h.putAlarms([{ id: "a", triggerAtMs: moved }]);
    await runFor(h, MINUTE);
    // The moved trigger's T-20 stage is open again; it goes out at the next alarm run.
    expect(leads(h, moved)).toEqual([22, 19]);
  });

  it("coalesces to one push per 2 minutes, keeping the most urgent kind", async () => {
    const h = await registered(FRESHNESS);
    await changeNow(h);
    await h.tick();
    h.advance(30 * 1000);
    await changeNow(h);
    expect(await h.tick()).toBe(false);
    expect(h.apns).toHaveLength(1);
    const pending = await h.row();
    expect(pending?.pending_change_at).toBe(h.now());
    expect(await h.alarmAt()).toBe(h.apns[0].body.aot.at + 2 * MINUTE);
    await runFor(h, 2 * MINUTE, 30 * 1000);
    expect(h.kinds()).toEqual(["change", "change"]);
    expect(h.apns[1].body.aot.at - h.apns[0].body.aot.at).toBe(2 * MINUTE);
  });

  it("renewal prompts go out 24 hours before expiry and every 6 hours until renewed", async () => {
    const h = await registered(FRESHNESS);
    const expires = h.now() + 30 * HOUR;
    expect((await h.putGoogle("renew-me", expires)).status).toBe(204);
    await runFor(h, 6 * HOUR - 10 * MINUTE, 10 * MINUTE);
    expect(h.apns).toHaveLength(0);
    await runFor(h, 13 * HOUR, 10 * MINUTE);
    expect(h.apns.map((call) => [call.body.aot.kind, call.body.aot.provider, (expires - call.body.aot.at) / HOUR])).toEqual([
      ["renew", "google", 24],
      ["renew", "google", 18],
      ["renew", "google", 12],
    ]);
    expect((await h.putGoogle("renew-me", h.now() + 7 * DAY)).status).toBe(204);
    await runFor(h, 12 * HOUR, 30 * MINUTE);
    expect(h.apns).toHaveLength(3);
  });
});

describe("device-reported syncs", () => {
  it("reset the heartbeat clock and the meeting-window gap", async () => {
    const h = await registered(POLLING);
    await runFor(h, 50 * MINUTE, 10 * MINUTE);
    expect((await h.synced(h.now())).status).toBe(204);
    await runFor(h, 50 * MINUTE, 10 * MINUTE);
    expect(h.apns).toHaveLength(0);
    await runFor(h, 10 * MINUTE, 10 * MINUTE);
    expect(h.kinds()).toEqual(["heartbeat"]);

    const trigger = h.now() + 40 * MINUTE;
    await h.putAlarms([{ id: "m", triggerAtMs: trigger }]);
    h.setNow(trigger - 28 * MINUTE);
    expect((await h.synced(h.now())).status).toBe(204);
    await runFor(h, 28 * MINUTE);
    expect(leads(h, trigger)).toEqual([23, 18, 13, 8, 3]);
  });

  it("satisfy a pending change recorded before them, but a later change still pushes", async () => {
    const h = await registered(FRESHNESS);
    await changeNow(h);
    await h.tick();
    h.advance(30 * 1000);
    await changeNow(h); // deferred by coalescing
    const changeAt = h.now();
    h.advance(10 * 1000);
    expect((await h.synced(changeAt)).status).toBe(204);
    expect((await h.row())?.pending_change_at).toBeNull();
    await runFor(h, 5 * MINUTE, 30 * 1000);
    expect(h.kinds()).toEqual(["change"]);

    // A change after the reported sync is not covered.
    const syncedAt = h.now();
    h.advance(1000);
    await changeNow(h);
    expect((await h.synced(syncedAt)).status).toBe(204);
    await h.tick();
    expect(h.kinds()).toEqual(["change", "change"]);
  });

  it("satisfy stages that started at or before them and ignore older reports", async () => {
    const h = await registered(FRESHNESS);
    const trigger = h.now() + HOUR;
    await h.putAlarms([{ id: "a", triggerAtMs: trigger }]);
    h.setNow(trigger - 20 * MINUTE);
    expect((await h.synced(h.now())).status).toBe(204);
    await runFor(h, 21 * MINUTE);
    expect(leads(h, trigger)).toEqual([8]);
    const before = await h.row();
    expect((await h.synced(h.apns[0].body.aot.at - MINUTE)).status).toBe(204);
    expect((await h.row())?.last_sync_at).toBe(before?.last_sync_at);
  });

  it("do not satisfy renewals", async () => {
    const h = await registered(FRESHNESS);
    const expires = h.now() + 24 * HOUR + 5 * MINUTE;
    await h.putGoogle("renew-sync", expires);
    h.setNow(expires - 24 * HOUR);
    expect((await h.synced(h.now())).status).toBe(204);
    await h.tick();
    expect(h.kinds()).toEqual(["renew"]);
  });
});

describe("APNs failures", () => {
  it("410 and BadDeviceToken disable the install until it registers again", async () => {
    for (const result of [{ status: 410, reason: "Unregistered" }, { status: 400, reason: "BadDeviceToken" }]) {
      const h = await registered(FRESHNESS);
      h.respond = () => result;
      await changeNow(h);
      await h.tick();
      const row = await h.row();
      expect(row).toMatchObject({ enabled: 0, disabled_reason: result.status === 410 ? "apns_unregistered" : "apns_bad_device_token", next_wake_at: null, claim_id: null });
      h.advance(5 * MINUTE);
      await changeNow(h);
      await h.tick();
      expect(h.apns).toHaveLength(1);
      h.respond = () => ({ status: 200 });
      expect((await h.update()).status).toBe(204);
      expect((await h.row())?.enabled).toBe(1);
    }
  });

  it("other failures back off 1, 2, 4 minutes and keep the change pending", async () => {
    const h = await registered(FRESHNESS);
    h.respond = (_call, index) => (index <= 3 ? { status: 500, reason: "InternalServerError" } : { status: 200 });
    await changeNow(h);
    await runFor(h, 10 * MINUTE, 30 * 1000);
    const times = h.apns.map((call) => call.body.aot.at);
    expect(times.slice(1).map((at, index) => (at - times[index]) / MINUTE)).toEqual([1, 2, 4]);
    expect((await h.row())).toMatchObject({ pending_change_at: null, failure_count: 0 });
  });

  it("transport errors are retried once, then back off", async () => {
    const h = await registered(FRESHNESS);
    h.respond = (_call, index) => (index <= 2 ? new Error("connection reset") : { status: 200 });
    await changeNow(h);
    await h.tick();
    expect(h.apns).toHaveLength(2);
    expect(await h.row()).toMatchObject({ failure_count: 1, claim_id: null });
    await runFor(h, MINUTE);
    expect(h.apns).toHaveLength(3);
    expect((await h.row())?.pending_change_at).toBeNull();
  });

  it("a 410 for an old token does not disable an install that registered a new token meanwhile", async () => {
    const h = await registered(FRESHNESS);
    const disabled = await runInDurableObject(await h.shard(), (instance) => {
      const shard = instance as unknown as { disableInstall(claim: object, reason: string, nowMs: number): boolean };
      const claim = { installId: h.installId, claimId: "c", apnsToken: "ef".repeat(32), environment: "development", plan: { kind: "change", renewalKeys: [] } };
      return shard.disableInstall(claim, "apns_unregistered", Date.now());
    });
    expect(disabled).toBe(false);
    expect(await h.row()).toMatchObject({ enabled: 1, apns_token: h.apnsToken });
  });

  it("disabled installs are deleted after 30 days with their index entries", async () => {
    const h = await registered(FRESHNESS);
    await h.putGraph("graph-pruned", h.now() + 300 * DAY);
    h.respond = () => ({ status: 410, reason: "Unregistered" });
    await changeNow(h);
    await h.tick();
    expect((await h.row())?.enabled).toBe(0);
    h.advance(30 * DAY);
    for (let run = 0; run < 5; run += 1) await h.tick();
    expect(await h.row()).toBeNull();
    const key = await subscriptionKey("microsoft", "graph-pruned");
    const index = env.SHARDS.getByName(await shardFor(`subscription:${key}`));
    expect(await h.sql(index, "SELECT * FROM sub_index WHERE sub_key = ?", key)).toEqual([]);
    expect((await h.update()).status).toBe(401);
  });
});

describe("shard alarm", () => {
  it("tracks the earliest wake time of the shard's installs", async () => {
    const h = await registered(POLLING);
    const shardName = await shardFor(`install:${h.installId}`);
    const rateShards = [
      await shardFor(`rate:${await sha256Hex(`registration:v4:${h.ip}`)}`),
      await shardFor(`rate:${await sha256Hex("registration:new-installs")}`),
    ];
    const stub = await h.shard();
    // Isolate the shard: drop everything that isn't this install so only its wake time counts.
    await h.sql(stub, "DELETE FROM installs WHERE install_id != ?", h.installId);
    await h.sql(stub, "DELETE FROM subscriptions WHERE install_id != ?", h.installId);
    await h.sql(stub, "DELETE FROM alarms WHERE install_id != ?", h.installId);
    await h.sql(stub, "DELETE FROM sub_index");
    if (!rateShards.includes(shardName)) await h.sql(stub, "DELETE FROM rate_limits");
    await h.update();
    const pruneFloor = rateShards.includes(shardName) ? (await h.sql<{ at: number }>(stub, "SELECT MIN(expires_at) AS at FROM rate_limits"))[0].at : Infinity;
    const expect_ = async (at: number) => expect(await h.alarmAt()).toBe(Math.min(at, pruneFloor));

    await expect_(h.now() + HOUR); // heartbeat
    const trigger = h.now() + 45 * MINUTE;
    await h.putAlarms([{ id: "x", triggerAtMs: trigger }]);
    await expect_(trigger - 30 * MINUTE); // meeting window opens
    h.setNow(trigger - 30 * MINUTE);
    await h.tick();
    expect(h.kinds()).toEqual(["precheck"]);
    await expect_(trigger - 25 * MINUTE);
    await h.putAlarms([]);
    await expect_(h.now() + HOUR);
    await h.update({ freshness: FRESHNESS });
    // Non-polling with nothing scheduled: no install wake at all.
    const alarm = await h.alarmAt();
    expect(alarm === null || alarm === pruneFloor || alarm > h.now() + DAY - 1).toBe(true);
  });

  it(`sends at most ${PUSH_BATCH_SIZE} pushes per run and continues immediately`, async () => {
    const h = await registered(FRESHNESS);
    const stub = await h.shard();
    const total = PUSH_BATCH_SIZE + 5;
    await runInDurableObject(stub, (_instance, state) => {
      for (let index = 0; index < total; index += 1) {
        state.storage.sql.exec(
          `INSERT INTO installs (install_id, secret_hash, apns_token, apns_environment, polling, active_start, active_end, time_zone,
             enabled, created_at, updated_at, pending_change_at, pending_change_provider, next_wake_at, priority_wake_at)
           VALUES (?, 'x', ?, 'development', 0, '06:00', '23:00', 'America/Los_Angeles', 1, ?, ?, ?, 'google', ?, ?)`,
          `bulk${String(index).padStart(18, "0")}`, h.apnsToken, h.now(), h.now(), h.now(), h.now(), h.now(),
        );
      }
    });
    await h.update(); // reschedules the alarm
    expect(await h.tick()).toBe(true);
    expect(h.apns).toHaveLength(PUSH_BATCH_SIZE);
    expect(await h.alarmAt()).toBeLessThanOrEqual(h.now());
    expect(await h.tick()).toBe(true);
    expect(h.apns).toHaveLength(total);
  });
});

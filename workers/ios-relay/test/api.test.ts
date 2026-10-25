import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clientNetworkKey, parseApiRoute } from "../src/http";
import worker from "../src/index";
import { shardFor } from "../src/util";
import { APNS_TOKEN, DAY, FRESHNESS, MINUTE, harness, sha256Hex, subscriptionKey } from "./helpers";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("routing", () => {
  it("accepts only the documented paths and methods", async () => {
    const h = await harness();
    expect(parseApiRoute("/v2/installations")).toEqual({ kind: "collection" });
    expect(parseApiRoute(`/v2/installations/${h.installId}/synced`)).toEqual({ kind: "synced", installId: h.installId });
    expect(parseApiRoute(`/v2/installations/${h.installId}/subscriptions/google/a%2Fb`)).toBeNull();
    expect(parseApiRoute(`/v1/installations/${h.installId}`)).toBeNull();
    expect(parseApiRoute("/v2/installations/short")).toBeNull();

    expect((await h.api("GET", "/")).status).toBe(404);
    expect((await h.api("POST", "/v1/installations")).status).toBe(404);
    const wrong = await h.api("GET", "/v2/installations");
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("POST");
    expect(wrong.headers.get("cache-control")).toBe("no-store");
    expect((await h.api("GET", `/v2/installations/${h.installId}/synced`)).headers.get("allow")).toBe("POST");
    expect((await h.api("GET", "/webhooks/google")).status).toBe(405);
  });

  it("groups IPv6 clients by /64 for rate limits", () => {
    const key = (ip: string) => clientNetworkKey(new Request("https://relay.test", { headers: { "cf-connecting-ip": ip } }));
    expect(key("203.0.113.9")).toBe("v4:203.0.113.9");
    expect(key("::ffff:203.0.113.9")).toBe("v4:203.0.113.9");
    expect(key("2001:db8:1:2:aaaa::1")).toBe("v6:2001:0db8:0001:0002");
    expect(key("2001:db8:1:2::2")).toBe(key("2001:db8:1:2:ffff:ffff:ffff:ffff"));
  });
});

describe("registration", () => {
  it("requires a valid App Check token, stores only the secret hash, and is idempotent", async () => {
    const h = await harness();
    expect((await h.register({}, { appCheck: null })).status).toBe(401);
    expect((await h.register({}, { appCheck: "not-a-token" })).status).toBe(401);
    const created = await h.register();
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ installId: h.installId });
    expect((await h.register()).status).toBe(200);
    const row = await h.row();
    expect(row?.secret_hash).toBe(await sha256Hex(h.secret));
    expect(JSON.stringify(row)).not.toContain(h.secret);
    expect(row?.polling).toBe(0);
    expect(row?.time_zone).toBe("America/Los_Angeles");

    const other = await harness();
    other.installId = h.installId;
    expect((await other.register()).status).toBe(409);
  });

  it("checks issuer, audience, app ID, expiry and signature of App Check tokens", async () => {
    const h = await harness();
    const refused = [
      await h.appCheck({ iss: "https://firebaseappcheck.googleapis.com/999" }),
      await h.appCheck({ aud: ["projects/999"] }),
      await h.appCheck({ sub: "1:1054144143721:ios:other" }),
      await h.appCheck({ exp: Math.floor(Date.now() / 1000) - 1 }),
      await h.appCheck({}, { kid: "unknown-kid" }),
      (await h.appCheck()).slice(0, -4) + "AAAA",
    ];
    for (const token of refused) expect((await h.register({}, { appCheck: token })).status).toBe(401);
    expect((await h.register()).status).toBe(201);
    // Keys are cached: one JWKS fetch, plus at most one refetch for the unknown key ID.
    expect(h.jwksFetches).toBeLessThanOrEqual(2);
  });

  it("validates every field and rejects unknown ones", async () => {
    const h = await harness();
    const cases: Array<Record<string, unknown>> = [
      { installId: "short" },
      { installSecret: "x".repeat(42) },
      { apnsToken: "AB".repeat(32) },
      { environment: "staging" },
      { freshness: { ...FRESHNESS, polling: "yes" } },
      { freshness: { polling: true, activeHours: FRESHNESS.activeHours } },
      { freshness: { ...FRESHNESS, activeHours: { start: "07:00", end: "07:00" } } },
      { freshness: { ...FRESHNESS, activeHours: { start: "7:00", end: "22:00" } } },
      { freshness: { ...FRESHNESS, timeZone: "Mars/Olympus" } },
      { freshness: { ...FRESHNESS, intervalMinutes: 20 } },
      { heartbeat: { intervalMinutes: 20 } },
      { extra: true },
    ];
    for (const overrides of cases) expect((await h.register(overrides)).status, JSON.stringify(overrides)).toBe(400);
    expect((await h.api("POST", "/v2/installations", { auth: null, appCheck: await h.appCheck(), body: "{" })).status).toBe(400);
    const huge = await h.api("POST", "/v2/installations", { auth: null, appCheck: await h.appCheck(), body: JSON.stringify({ pad: "x".repeat(40 * 1024) }) });
    expect(huge.status).toBe(413);
  });

  it("is rate limited per client network", async () => {
    const h = await harness();
    for (let attempt = 0; attempt < 20; attempt += 1) expect((await h.register({ environment: "nope" })).status).toBe(400);
    expect((await h.register()).status).toBe(429);
    expect((await h.register({}, { ip: "203.0.113.200" })).status).toBe(201);
    h.advance(60 * MINUTE);
    expect((await h.register()).status).toBe(200);
  });

  it("lets enforcement be relaxed, but still refuses an invalid token", async () => {
    const h = await harness();
    const relaxed = { ...env, ENFORCE_APP_CHECK: "false" } as unknown as Parameters<typeof worker.fetch>[1];
    const send = async (appCheck: string | null) => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request("https://relay.test/v2/installations", {
        method: "POST",
        headers: { "cf-connecting-ip": h.ip, "content-type": "application/json", ...(appCheck ? { "x-firebase-appcheck": appCheck } : {}) },
        body: JSON.stringify({ installId: h.installId, installSecret: h.secret, apnsToken: APNS_TOKEN, environment: "development", freshness: FRESHNESS }),
      }), relaxed, ctx);
      await waitOnExecutionContext(ctx);
      return response.status;
    };
    expect(await send("invalid")).toBe(401);
    expect(await send(null)).toBe(201);
    expect((await h.register({}, { appCheck: null })).status).toBe(401);
  });

  it("caps new installs overall, but an existing install can always re-register", async () => {
    const h = await harness();
    expect((await h.register()).status).toBe(201);
    const keyHash = await sha256Hex("registration:new-installs");
    const stub = env.SHARDS.getByName(await shardFor(`rate:${keyHash}`));
    await h.sql(stub, "UPDATE rate_limits SET count = 2000 WHERE key_hash = ?", keyHash);
    expect((await h.register()).status).toBe(200);
    const fresh = await harness();
    expect((await fresh.register()).status).toBe(429);
    await h.sql(stub, "DELETE FROM rate_limits WHERE key_hash = ?", keyHash);
  });
});

describe("authenticated calls", () => {
  it("need the bearer secret; App Check is optional but checked when sent", async () => {
    const h = await harness();
    await h.register();
    expect((await h.update({}, )).status).toBe(204);
    expect((await h.api("PUT", `/v2/installations/${h.installId}`, { auth: null, body: {} })).status).toBe(401);
    expect((await h.api("PUT", `/v2/installations/${h.installId}`, { auth: "w".repeat(43), body: { apnsToken: APNS_TOKEN, environment: "development", freshness: FRESHNESS } })).status).toBe(401);
    expect((await h.api("PUT", `/v2/installations/${h.installId}`, { appCheck: "bogus", body: { apnsToken: APNS_TOKEN, environment: "development", freshness: FRESHNESS } })).status).toBe(401);
    expect((await h.api("PUT", `/v2/installations/${h.installId}`, { appCheck: await h.appCheck(), body: { apnsToken: APNS_TOKEN, environment: "development", freshness: FRESHNESS } })).status).toBe(204);
    const unknown = await harness();
    expect((await unknown.update()).status).toBe(401);
  });

  it("are rate limited to 60 per install per minute", async () => {
    const h = await harness();
    await h.register();
    for (let call = 0; call < 60; call += 1) expect((await h.putAlarms([])).status).toBe(204);
    expect((await h.putAlarms([])).status).toBe(429);
    h.advance(MINUTE);
    expect((await h.putAlarms([])).status).toBe(204);
  });

  it("update changes token and freshness and re-enables a disabled install", async () => {
    const h = await harness();
    await h.register();
    await h.sql(await h.shard(), "UPDATE installs SET enabled = 0, disabled_at = ?, disabled_reason = 'apns_unregistered' WHERE install_id = ?", h.now(), h.installId);
    expect((await h.update({ apnsToken: "cd".repeat(40), environment: "production", freshness: { ...FRESHNESS, polling: true } })).status).toBe(204);
    const row = await h.row();
    expect(row).toMatchObject({ apns_token: "cd".repeat(40), apns_environment: "production", polling: 1, enabled: 1, disabled_at: null });
    expect((await h.update({ heartbeat: {} })).status).toBe(400);
  });

  it("alarm snapshots store hashed IDs and times only, dropping past and far entries", async () => {
    const h = await harness();
    await h.register();
    const response = await h.putAlarms([
      { id: "event-123|2030", triggerAtMs: h.now() + 60 * MINUTE },
      { id: "past", triggerAtMs: h.now() - 1 },
      { id: "far", triggerAtMs: h.now() + 91 * DAY },
    ]);
    expect(response.status).toBe(204);
    const rows = await h.sql(await h.shard(), "SELECT * FROM alarms WHERE install_id = ?", h.installId);
    expect(rows).toEqual([{ install_id: h.installId, alarm_key: await sha256Hex("event-123|2030"), trigger_at: h.now() + 60 * MINUTE, sent_t20: null, sent_t8: null }]);
    expect((await h.putAlarms([{ id: "a", triggerAtMs: 1 }, { id: "a", triggerAtMs: 2 }])).status).toBe(400);
    expect((await h.putAlarms(Array.from({ length: 129 }, (_, index) => ({ id: `a${index}`, triggerAtMs: h.now() + MINUTE })))).status).toBe(400);
    expect((await h.putAlarms([{ id: "\u0001", triggerAtMs: h.now() + MINUTE }])).status).toBe(400);
    expect((await h.putAlarms([{ id: "x", triggerAtMs: 1.5 }])).status).toBe(400);
    expect((await h.putAlarms([])).status).toBe(204);
    expect(await h.sql(await h.shard(), "SELECT * FROM alarms WHERE install_id = ?", h.installId)).toEqual([]);
  });

  it("synced validates its body and clock", async () => {
    const h = await harness();
    await h.register();
    expect((await h.synced(h.now())).status).toBe(204);
    expect((await h.synced(h.now() + 59 * 1000)).status).toBe(204);
    expect((await h.synced(h.now() + 2 * MINUTE)).status).toBe(400);
    expect((await h.api("POST", `/v2/installations/${h.installId}/synced`, { body: { syncedAtMs: h.now(), extra: 1 } })).status).toBe(400);
    expect((await h.api("POST", `/v2/installations/${h.installId}/synced`, { body: { syncedAtMs: "now" } })).status).toBe(400);
    // Clamped to the server clock.
    expect((await h.row())?.last_sync_at).toBe(h.now());
    expect((await h.api("POST", `/v2/installations/${h.installId}/synced`, { auth: "w".repeat(43), body: { syncedAtMs: h.now() } })).status).toBe(401);
  });

  it("delete removes the install, its alarms, subscriptions and index entries", async () => {
    const h = await harness();
    await h.register();
    await h.putAlarms([{ id: "a", triggerAtMs: h.now() + HOUR() }]);
    expect((await h.putGoogle("chan-delete")).status).toBe(204);
    expect((await h.api("DELETE", `/v2/installations/${h.installId}`)).status).toBe(204);
    expect(await h.row()).toBeNull();
    expect(await h.sql(await h.shard(), "SELECT * FROM alarms WHERE install_id = ?", h.installId)).toEqual([]);
    expect(await h.sql(await h.shard(), "SELECT * FROM subscriptions WHERE install_id = ?", h.installId)).toEqual([]);
    const key = await subscriptionKey("google", "chan-delete");
    expect(await h.sql(env.SHARDS.getByName(await shardFor(`subscription:${key}`)), "SELECT * FROM sub_index WHERE sub_key = ?", key)).toEqual([]);
    expect((await h.api("DELETE", `/v2/installations/${h.installId}`)).status).toBe(401);
  });
});

function HOUR() {
  return 60 * MINUTE;
}

describe("subscriptions", () => {
  it("store hashes only, route through the index, and enforce ownership", async () => {
    const h = await harness();
    await h.register();
    expect((await h.putGoogle("chan-1")).status).toBe(204);
    const key = await subscriptionKey("google", "chan-1");
    const rows = await h.sql(await h.shard(), "SELECT * FROM subscriptions WHERE sub_key = ?", key);
    expect(rows[0]).toMatchObject({ install_id: h.installId, provider: "google", resource_id_hash: await sha256Hex("resource-123") });
    expect(JSON.stringify(rows)).not.toContain("chan-1");
    const index = env.SHARDS.getByName(await shardFor(`subscription:${key}`));
    expect(await h.sql(index, "SELECT install_id FROM sub_index WHERE sub_key = ?", key)).toEqual([{ install_id: h.installId }]);

    const other = await harness();
    await other.register();
    expect((await other.putGoogle("chan-1")).status).toBe(409);
    // Deleting someone else's subscription is a silent no-op.
    expect((await other.api("DELETE", `/v2/installations/${other.installId}/subscriptions/google/chan-1`)).status).toBe(204);
    expect(await h.sql(index, "SELECT install_id FROM sub_index WHERE sub_key = ?", key)).toEqual([{ install_id: h.installId }]);

    expect((await h.api("DELETE", `/v2/installations/${h.installId}/subscriptions/google/chan-1`)).status).toBe(204);
    expect(await h.sql(index, "SELECT install_id FROM sub_index WHERE sub_key = ?", key)).toEqual([]);
    expect((await other.putGoogle("chan-1")).status).toBe(204);
  });

  it("take over a stale index entry whose install no longer holds the subscription", async () => {
    const h = await harness();
    await h.register();
    await h.putGraph("graph-stale");
    // Simulate an install pruned without its index entry being released.
    await h.sql(await h.shard(), "DELETE FROM subscriptions WHERE install_id = ?", h.installId);
    const next = await harness();
    await next.register();
    expect((await next.putGraph("graph-stale")).status).toBe(204);
  });

  it("validate bodies and enforce the 64-subscription limit (expired ones don't count)", async () => {
    const h = await harness();
    await h.register();
    expect((await h.putGoogle("c", h.now())).status).toBe(400);
    expect((await h.putGoogle("c", h.now() + 367 * DAY)).status).toBe(400);
    expect((await h.putGoogle("c", undefined, { channelTokenHash: "ABC" })).status).toBe(400);
    expect((await h.putGoogle("c", undefined, { resourceId: "has space" })).status).toBe(400);
    expect((await h.api("PUT", `/v2/installations/${h.installId}/subscriptions/microsoft/m`, { body: { expiresAtMs: h.now() + DAY, clientStateHash: "a".repeat(64), resourceId: "x" } })).status).toBe(400);
    for (let index = 0; index < 64; index += 1) {
      if (index % 40 === 39) h.advance(MINUTE); // stay under 60 calls a minute
      expect((await h.putGraph(`graph-${index}`)).status).toBe(204);
    }
    h.advance(MINUTE);
    expect((await h.putGraph("graph-64")).status).toBe(409);
    expect((await h.putGraph("graph-0", h.now() + 4 * DAY)).status).toBe(204);
    // An expired mapping frees its slot.
    await h.sql(await h.shard(), "UPDATE subscriptions SET expires_at = ? WHERE sub_key = ?", h.now() - 1, await subscriptionKey("microsoft", "graph-1"));
    expect((await h.putGraph("graph-64")).status).toBe(204);
    // The failed attempt left no index entry behind.
    const key = await subscriptionKey("microsoft", "graph-65");
    expect((await h.putGraph("graph-65")).status).toBe(409);
    expect(await h.sql(env.SHARDS.getByName(await shardFor(`subscription:${key}`)), "SELECT * FROM sub_index WHERE sub_key = ?", key)).toEqual([]);
  });
});

import { env, exports } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { INDEX_RELEASE_GRACE_MS } from "../src/shard";
import { CHANNEL_TOKEN, CLIENT_STATE, DAY, MINUTE, RESOURCE_ID, harness, sha256Hex, shardFor, subscriptionKey, tickShard, type Harness } from "./helpers";

/** Calls the Worker directly and waits for its waitUntil work (index releases) to finish. */
async function fetchAndSettle(url: string, init: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(url, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const googleHeaders = (channelId: string, state = "exists") => ({
  "x-goog-channel-id": channelId,
  "x-goog-channel-token": CHANNEL_TOKEN,
  "x-goog-resource-id": RESOURCE_ID,
  "x-goog-resource-state": state,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function withGoogle(channelId = `chan-${crypto.randomUUID()}`, options: { expiresInMs?: number } = {}): Promise<{ h: Harness; channelId: string }> {
  const h = await harness();
  expect((await h.register()).status).toBe(201);
  expect((await h.putGoogle(channelId, options.expiresInMs === undefined ? undefined : h.now() + options.expiresInMs)).status).toBe(204);
  return { h, channelId };
}

async function withGraph(options: { expiresInMs?: number } = {}): Promise<{ h: Harness; subscriptionId: string }> {
  const h = await harness();
  expect((await h.register()).status).toBe(201);
  const subscriptionId = `graph-${crypto.randomUUID()}`;
  expect((await h.putGraph(subscriptionId, options.expiresInMs === undefined ? undefined : h.now() + options.expiresInMs)).status).toBe(204);
  return { h, subscriptionId };
}

const graphItem = (subscriptionId: string, extra: Record<string, unknown> = {}) => ({
  subscriptionId,
  clientState: CLIENT_STATE,
  changeType: "updated",
  resource: "Users/x/Events/y",
  ...extra,
});

describe("Google webhook", () => {
  it("verifies the channel token and resource, then pushes from the shard alarm", async () => {
    const { h, channelId } = await withGoogle();
    expect((await h.google(channelId, { "x-goog-channel-token": "wrong" })).status).toBe(403);
    const noToken = await exports.default.fetch("https://relay.test/webhooks/google", {
      method: "POST",
      headers: { "x-goog-channel-id": channelId, "x-goog-resource-id": "resource-123", "x-goog-resource-state": "exists" },
    });
    expect(noToken.status).toBe(403);
    expect((await h.google(channelId, { "x-goog-resource-id": "other" })).status).toBe(204);
    expect((await h.google(channelId, { "x-goog-resource-state": "sync" })).status).toBe(204);
    await h.tick();
    expect(h.apns).toHaveLength(0);

    const response = await h.google(channelId);
    expect(response.status).toBe(204);
    // The webhook only records the change; the shard alarm, due now, sends the push.
    expect(h.apns).toHaveLength(0);
    expect(await h.alarmAt()).toBe(h.now());
    expect(await h.tick()).toBe(true);
    expect(h.apns.map((call) => call.body.aot)).toEqual([{ v: 1, kind: "change", provider: "google", at: h.now() }]);
    expect((await h.row())?.pending_change_at).toBeNull();
  });

  it("answers 204 for unknown or expired channels and 400 without a channel ID", async () => {
    const h = await harness();
    expect((await h.google("never-registered")).status).toBe(204);
    const bad = await exports.default.fetch("https://relay.test/webhooks/google", { method: "POST" });
    expect(bad.status).toBe(400);
    const { h: expiring, channelId } = await withGoogle(undefined, { expiresInMs: MINUTE });
    expiring.advance(MINUTE);
    expect((await expiring.google(channelId)).status).toBe(204);
    await expiring.tick();
    expect(expiring.apns).toHaveLength(0);
  });

  it("routes through the subscription index without scanning installs", async () => {
    // Find a channel whose index shard differs from its install's shard, to prove the hop.
    let found: { h: Harness; channelId: string } | null = null;
    for (let attempt = 0; attempt < 20 && !found; attempt += 1) {
      const candidate = await withGoogle();
      const key = await subscriptionKey("google", candidate.channelId);
      if (await shardFor(`subscription:${key}`) !== await shardFor(`install:${candidate.h.installId}`)) found = candidate;
    }
    if (!found) throw new Error("no cross-shard subscription found");
    const { h, channelId } = found;
    const key = await subscriptionKey("google", channelId);
    const index = env.SHARDS.getByName(await shardFor(`subscription:${key}`));
    expect(await h.sql(index, "SELECT install_id FROM sub_index WHERE sub_key = ?", key)).toEqual([{ install_id: h.installId }]);
    // The index holds no install data; the install shard holds no index entry for it.
    expect(await h.sql(index, "SELECT * FROM installs WHERE install_id = ?", h.installId)).toEqual([]);
    expect(await h.sql(await h.shard(), "SELECT * FROM sub_index WHERE sub_key = ?", key)).toEqual([]);

    // Without the index entry the webhook cannot find the install.
    await h.sql(index, "DELETE FROM sub_index WHERE sub_key = ?", key);
    expect((await h.google(channelId)).status).toBe(204);
    await h.tick();
    expect(h.apns).toHaveLength(0);
  });

  it("drops an index entry whose install no longer has the subscription, once it is 5 minutes old", async () => {
    const { h, channelId } = await withGoogle();
    const key = await subscriptionKey("google", channelId);
    const index = env.SHARDS.getByName(await shardFor(`subscription:${key}`));
    await h.sql(await h.shard(), "DELETE FROM subscriptions WHERE sub_key = ?", key);
    h.advance(INDEX_RELEASE_GRACE_MS - MINUTE);
    expect((await fetchAndSettle("https://relay.test/webhooks/google", { method: "POST", headers: googleHeaders(channelId) })).status).toBe(204);
    expect(await h.sql(index, "SELECT install_id FROM sub_index WHERE sub_key = ?", key)).toEqual([{ install_id: h.installId }]);
    h.advance(MINUTE);
    expect((await fetchAndSettle("https://relay.test/webhooks/google", { method: "POST", headers: googleHeaders(channelId) })).status).toBe(204);
    expect(await h.sql(index, "SELECT * FROM sub_index WHERE sub_key = ?", key)).toEqual([]);
  });

  it("keeps a new channel's index entry when its sync notification races the PUT", async () => {
    const h = await harness();
    expect((await h.register()).status).toBe(201);
    const channelId = `chan-${crypto.randomUUID()}`;
    const key = await subscriptionKey("google", channelId);
    const index = env.SHARDS.getByName(await shardFor(`subscription:${key}`));
    const expiresAt = h.now() + 7 * DAY;
    // The PUT's first step claims the index entry...
    expect(await index.indexClaim(key, h.installId, expiresAt)).toEqual({ status: "ok", created: true });
    // ...then Google's sync notification for the new channel arrives before the mapping exists...
    expect((await fetchAndSettle("https://relay.test/webhooks/google", { method: "POST", headers: googleHeaders(channelId, "sync") })).status).toBe(204);
    // ...and only then does the PUT write the mapping.
    const stored = await (await h.shard()).upsertSubscription(h.installId, key, {
      provider: "google",
      resourceIdHash: await sha256Hex(RESOURCE_ID),
      verificationHash: await sha256Hex(CHANNEL_TOKEN),
      expiresAt,
    });
    expect(stored.status).toBe("ok");
    expect(await h.sql(index, "SELECT install_id FROM sub_index WHERE sub_key = ?", key)).toEqual([{ install_id: h.installId }]);
    expect(await h.sql(await h.shard(), "SELECT sub_key FROM subscriptions WHERE sub_key = ?", key)).toEqual([{ sub_key: key }]);
    // A later change on the channel still pushes.
    expect((await h.google(channelId)).status).toBe(204);
    await h.tick();
    expect(h.kinds()).toEqual(["change"]);
  });
});

describe("Microsoft Graph webhook", () => {
  it("echoes the validation token as text/plain for POST and GET", async () => {
    for (const method of ["POST", "GET"]) {
      const response = await exports.default.fetch("https://relay.test/webhooks/microsoft?validationToken=Validation%3A%20Testing%20client%20application", { method });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await response.text()).toBe("Validation: Testing client application");
    }
    expect((await exports.default.fetch("https://relay.test/webhooks/microsoft?validationToken=", { method: "POST" })).status).toBe(400);
    expect((await exports.default.fetch("https://relay.test/webhooks/microsoft", { method: "GET" })).status).toBe(405);
  });

  it("answers 202 without calling APNs, checks clientState, and sends one push per install", async () => {
    const { h, subscriptionId } = await withGraph();
    const response = await h.graph([graphItem(subscriptionId), graphItem(subscriptionId), graphItem(subscriptionId, { clientState: "forged" })]);
    expect(response.status).toBe(202);
    expect(h.apns).toHaveLength(0);
    expect(await h.tick()).toBe(true);
    expect(h.apns.map((call) => call.body.aot.kind)).toEqual(["change"]);
    expect(h.apns[0].body.aot.provider).toBe("microsoft");

    const forgedOnly = await withGraph();
    expect((await forgedOnly.h.graph([graphItem(forgedOnly.subscriptionId, { clientState: "forged" })])).status).toBe(202);
    await forgedOnly.h.tick();
    expect(forgedOnly.h.apns).toHaveLength(0);
  });

  it("turns reauthorizationRequired and subscriptionRemoved into renew pushes, and missed into a change", async () => {
    const { h, subscriptionId } = await withGraph();
    expect((await h.graph([graphItem(subscriptionId, { lifecycleEvent: "reauthorizationRequired" })])).status).toBe(202);
    await h.tick();
    expect(h.apns.map((call) => call.body.aot)).toEqual([{ v: 1, kind: "renew", provider: "microsoft", at: h.now() }]);
    h.advance(3 * MINUTE);
    expect((await h.graph([graphItem(subscriptionId, { lifecycleEvent: "subscriptionRemoved" })])).status).toBe(202);
    await h.tick();
    expect(h.kinds()).toEqual(["renew", "renew"]);
    h.advance(3 * MINUTE);
    expect((await h.graph([graphItem(subscriptionId, { lifecycleEvent: "missed" })])).status).toBe(202);
    await h.tick();
    expect(h.kinds()).toEqual(["renew", "renew", "change"]);
  });

  it("routes lifecycle events after the recorded expiry but ignores late change notifications", async () => {
    const { h, subscriptionId } = await withGraph({ expiresInMs: 10 * MINUTE });
    h.advance(10 * MINUTE);
    expect((await h.graph([graphItem(subscriptionId)])).status).toBe(202);
    await h.tick();
    expect(h.apns).toHaveLength(0);
    expect((await h.graph([graphItem(subscriptionId, { lifecycleEvent: "reauthorizationRequired" })])).status).toBe(202);
    await h.tick();
    expect(h.kinds()).toEqual(["renew"]);
    // One push per request, not the 6-hour retries.
    h.advance(7 * 60 * MINUTE);
    await h.tick();
    expect(h.kinds()).toEqual(["renew"]);
  });

  it("rejects malformed and oversized batches", async () => {
    const h = await harness();
    const post = (body: string) => exports.default.fetch("https://relay.test/webhooks/microsoft", { method: "POST", body });
    expect((await post("not json")).status).toBe(400);
    expect((await post(JSON.stringify({ value: "x" }))).status).toBe(400);
    expect((await post(JSON.stringify({ value: Array.from({ length: 1001 }, () => ({})) }))).status).toBe(400);
    expect((await h.graph(Array.from({ length: 101 }, (_, index) => graphItem(`s-${index}`)))).status).toBe(400);
    expect((await post(JSON.stringify({ value: [], pad: "x".repeat(1024 * 1024) }))).status).toBe(413);
    // Items without a usable subscription ID or clientState are skipped, not fatal.
    expect((await h.graph([{ subscriptionId: "a b", clientState: "x" }, { subscriptionId: "a" }])).status).toBe(202);
  });

  it("handles a batch naming installs in several shards", async () => {
    const first = await withGraph();
    const second = await withGraph();
    const response = await first.h.graph([graphItem(first.subscriptionId), graphItem(second.subscriptionId), graphItem("unknown-subscription")]);
    expect(response.status).toBe(202);
    await first.h.tick(first.h.installId);
    await first.h.tick(second.h.installId);
    // The newest harness owns the fetch mock.
    expect(second.h.allApns.filter((call) => call.url.endsWith(first.h.apnsToken) || call.url.endsWith(second.h.apnsToken))).toHaveLength(2);
  });

  it("keeps a new subscription's index entry when a notification races the PUT", async () => {
    const h = await harness();
    expect((await h.register()).status).toBe(201);
    const subscriptionId = `graph-${crypto.randomUUID()}`;
    const key = await subscriptionKey("microsoft", subscriptionId);
    const index = env.SHARDS.getByName(await shardFor(`subscription:${key}`));
    await index.indexClaim(key, h.installId, h.now() + DAY);
    const response = await fetchAndSettle("https://relay.test/webhooks/microsoft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: [graphItem(subscriptionId)] }),
    });
    expect(response.status).toBe(202);
    expect(await h.sql(index, "SELECT install_id FROM sub_index WHERE sub_key = ?", key)).toEqual([{ install_id: h.installId }]);
  });

  it("prunes disabled installs within the run budget, continuing in the next run", async () => {
    const h = await harness();
    expect((await h.register()).status).toBe(201);
    const shard = await h.shard();
    const owners = ["prunedA00000000000000", "prunedB00000000000000"];
    const keys = new Map<string, string[]>();
    for (const owner of owners) {
      const ownerKeys = await Promise.all(Array.from({ length: 16 }, () => subscriptionKey("microsoft", crypto.randomUUID())));
      keys.set(owner, ownerKeys);
      await h.sql(shard, `INSERT INTO installs (install_id, secret_hash, apns_token, apns_environment, polling, active_start, active_end,
          time_zone, enabled, disabled_at, created_at, updated_at) VALUES (?, 'x', ?, 'development', 0, '06:00', '23:00', 'UTC', 0, ?, 0, 0)`,
        owner, h.apnsToken, h.now() - 31 * DAY);
      for (const key of ownerKeys) {
        await h.sql(shard, `INSERT INTO subscriptions (sub_key, install_id, provider, verification_hash, expires_at, created_at, updated_at)
            VALUES (?, ?, 'microsoft', 'x', ?, 0, 0)`, key, owner, h.now() + DAY);
        await env.SHARDS.getByName(await shardFor(`subscription:${key}`)).indexClaim(key, owner, h.now() + DAY);
      }
    }
    await h.update(); // reschedules the alarm
    const remaining = async () => (await h.sql<{ install_id: string }>(shard, "SELECT install_id FROM installs WHERE install_id IN (?, ?)", ...owners)).map((row) => row.install_id);
    const indexed = async (owner: string) => {
      let count = 0;
      for (const key of keys.get(owner) ?? []) {
        count += (await h.sql(env.SHARDS.getByName(await shardFor(`subscription:${key}`)), "SELECT 1 FROM sub_index WHERE sub_key = ?", key)).length;
      }
      return count;
    };
    // 16 keys name more than 10 index shards (a quarter of the 40-call budget): one install per run.
    expect(await h.tick()).toBe(true);
    expect(await remaining()).toEqual([owners[1]]);
    expect(await indexed(owners[0])).toBe(0);
    expect(await indexed(owners[1])).toBe(16);
    expect(await h.alarmAt()).toBeLessThanOrEqual(h.now());
    expect(await h.tick()).toBe(true);
    expect(await remaining()).toEqual([]);
    expect(await indexed(owners[1])).toBe(0);
  });

  it("keeps expired mappings for 7 days, then prunes them and their index entries", async () => {
    const { h, subscriptionId } = await withGraph({ expiresInMs: DAY });
    const key = await subscriptionKey("microsoft", subscriptionId);
    h.advance(DAY + 7 * DAY);
    // Run whichever shard alarms are due (renewal prompts, pruning) until quiet.
    for (let run = 0; run < 5; run += 1) await h.tick();
    const index = env.SHARDS.getByName(await shardFor(`subscription:${key}`));
    for (let run = 0; run < 5 && await tickShard(index); run += 1);
    expect(await h.sql(await h.shard(), "SELECT * FROM subscriptions WHERE sub_key = ?", key)).toEqual([]);
    expect(await h.sql(index, "SELECT * FROM sub_index WHERE sub_key = ?", key)).toEqual([]);
  });
});

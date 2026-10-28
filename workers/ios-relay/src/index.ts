// Always On Time iOS push relay: device API v2 and provider webhooks (docs/IOS_PUSH_PROTOCOL.md).

import { verifyAppCheckToken } from "./appcheck";
import type { Env } from "./env";
import {
  HttpError,
  MAX_API_BODY_BYTES,
  MAX_WEBHOOK_BODY_BYTES,
  ROUTE_METHODS,
  clientNetworkKey,
  errorResponse,
  json,
  parseApiRoute,
  parseBearer,
  readJson,
  text,
  validProviderId,
  validateAlarms,
  validateRegistration,
  validateSubscription,
  validateSynced,
  validateReceipt,
  validateUpdate,
  type ApiRoute,
} from "./http";
import { INDEX_RELEASE_GRACE_MS, InstallShard, MAX_SUBSCRIPTIONS_PER_INSTALL, releaseIndexEntries, type DeviceOp, type GraphItem } from "./shard";
import { alarmKey, errorName, log, sha256Hex, shardFor, subscriptionKey } from "./util";

export { InstallShard };
export { ApnsTokenAuthority } from "./apns-token";

export const REGISTRATION_RATE = Object.freeze({ limit: 20, windowMs: 60 * 60 * 1000 });
/** New installs per hour from all networks together; installs re-registering don't count. */
export const NEW_INSTALL_RATE = Object.freeze({ limit: 2000, windowMs: 60 * 60 * 1000 });
const MAX_GRAPH_NOTIFICATIONS = 1000;
const MAX_GRAPH_SUBSCRIPTIONS_PER_REQUEST = 100;

type Stub = DurableObjectStub<InstallShard>;

async function installShard(env: Env, installId: string): Promise<Stub> {
  return env.SHARDS.getByName(await shardFor(`install:${installId}`));
}

async function indexShard(env: Env, key: string): Promise<Stub> {
  return env.SHARDS.getByName(await shardFor(`subscription:${key}`));
}

async function consumeRate(env: Env, key: string, rate: { limit: number; windowMs: number }): Promise<boolean> {
  const keyHash = await sha256Hex(key);
  const stub = env.SHARDS.getByName(await shardFor(`rate:${keyHash}`));
  return stub.consumeRate(keyHash, rate.limit, rate.windowMs);
}

function appCheckEnforced(env: Env): boolean {
  return env.ENFORCE_APP_CHECK !== "false";
}

/**
 * App Check is required for registration (unless enforcement is off). Other device calls verify a
 * token when one is sent but do not require it, because the NSE may not be able to get one.
 */
async function checkAppCheck(request: Request, env: Env, required: boolean): Promise<void> {
  const token = request.headers.get("x-firebase-appcheck");
  if (!token) {
    if (required && appCheckEnforced(env)) throw new HttpError(401, "Firebase App Check token required");
    return;
  }
  let valid = false;
  try {
    valid = await verifyAppCheckToken(token, {
      projectNumber: env.APP_CHECK_PROJECT_NUMBER,
      appIds: env.APP_CHECK_APP_IDS.split(",").map((id) => id.trim()).filter(Boolean),
    });
  } catch (error) {
    log("warn", "App Check verification failed", { error: errorName(error) });
  }
  if (!valid) throw new HttpError(401, "invalid Firebase App Check token");
}

async function register(request: Request, env: Env): Promise<Response> {
  await checkAppCheck(request, env, true);
  if (!await consumeRate(env, `registration:${clientNetworkKey(request)}`, REGISTRATION_RATE)) {
    throw new HttpError(429, "registration rate limit exceeded");
  }
  const body = validateRegistration(await readJson(request, MAX_API_BODY_BYTES));
  const shard = await installShard(env, body.installId);
  if (!await shard.installExists(body.installId) && !await consumeRate(env, "registration:new-installs", NEW_INSTALL_RATE)) {
    throw new HttpError(429, "registration rate limit exceeded");
  }
  const outcome = await shard.register(body.installId, await sha256Hex(body.installSecret), {
    apnsToken: body.apnsToken,
    environment: body.environment,
    freshness: body.freshness,
    receiptVersion: body.receiptVersion,
    deliveryEligible: body.deliveryEligible,
  });
  if (outcome === "conflict") throw new HttpError(409, "install ID is already registered");
  return json(outcome === "created" ? 201 : 200, { installId: body.installId });
}

async function runDevice(shard: Stub, installId: string, secretHash: string, op: DeviceOp): Promise<string[]> {
  const result = await shard.device(installId, secretHash, op);
  if (result.status === "unauthorized") throw new HttpError(401, "invalid install credentials");
  if (result.status === "rate-limited") throw new HttpError(429, "rate limit exceeded");
  return result.releasedKeys;
}

async function putSubscription(env: Env, shard: Stub, route: Extract<ApiRoute, { kind: "subscription" }>, request: Request, secretHash: string): Promise<Response> {
  const input = validateSubscription(route.provider, await readJson(request, MAX_API_BODY_BYTES), Date.now());
  await runDevice(shard, route.installId, secretHash, { kind: "authorize" });
  const key = await subscriptionKey(route.provider, route.subscriptionId);
  const index = await indexShard(env, key);
  let claim = await index.indexClaim(key, route.installId, input.expiresAt);
  if (claim.status === "conflict") {
    // The index may still name an install that has since dropped the subscription (deleted or
    // pruned); take it over only after its shard confirms that.
    const owner = claim.ownerId;
    if (await (await installShard(env, owner)).ownsSubscription(owner, key)) {
      throw new HttpError(409, "subscription is registered to another install");
    }
    claim = await index.indexClaim(key, route.installId, input.expiresAt, owner);
    if (claim.status === "conflict") throw new HttpError(409, "subscription is registered to another install");
  }
  const stored = await shard.upsertSubscription(route.installId, key, {
    provider: input.provider,
    resourceIdHash: input.resourceId === undefined ? null : await sha256Hex(input.resourceId),
    verificationHash: input.verificationHash,
    expiresAt: input.expiresAt,
  });
  if (stored.status !== "ok") {
    if (claim.created) await index.indexRelease([{ key, installId: route.installId }]);
    if (stored.status === "unknown-install") throw new HttpError(401, "invalid install credentials");
    throw new HttpError(409, `at most ${MAX_SUBSCRIPTIONS_PER_INSTALL} subscriptions per install`);
  }
  if (stored.droppedKeys.length > 0) {
    await releaseIndexEntries(env, stored.droppedKeys.map((dropped) => ({ key: dropped, installId: route.installId })));
  }
  return json(204);
}

async function deviceApi(request: Request, env: Env, url: URL): Promise<Response> {
  const route = parseApiRoute(url.pathname);
  if (!route) return json(404, { error: "not found" });
  const method = request.method.toUpperCase();
  if (!ROUTE_METHODS[route.kind].includes(method)) {
    return json(405, { error: "method not allowed" }, { allow: ROUTE_METHODS[route.kind].join(", ") });
  }
  try {
    if (route.kind === "collection") return await register(request, env);

    const secret = parseBearer(request.headers.get("authorization"));
    if (!secret) throw new HttpError(401, "invalid install credentials");
    await checkAppCheck(request, env, false);
    const secretHash = await sha256Hex(secret);
    const shard = await installShard(env, route.installId);
    const nowMs = Date.now();

    if (route.kind === "installation" && method === "GET") {
      const result = await shard.device(route.installId, secretHash, { kind: "status" });
      if (result.status === "unauthorized") throw new HttpError(401, "invalid install credentials");
      if (result.status === "rate-limited") throw new HttpError(429, "rate limit exceeded");
      return json(200, result.install ?? {});
    }
    if (route.kind === "installation" && method === "PUT") {
      const fields = validateUpdate(await readJson(request, MAX_API_BODY_BYTES));
      await runDevice(shard, route.installId, secretHash, { kind: "update", fields });
      return json(204);
    }
    if (route.kind === "installation") {
      const released = await runDevice(shard, route.installId, secretHash, { kind: "delete" });
      await releaseIndexEntries(env, released.map((key) => ({ key, installId: route.installId })));
      return json(204);
    }
    if (route.kind === "alarms") {
      const alarms = validateAlarms(await readJson(request, MAX_API_BODY_BYTES), nowMs);
      const hashed = await Promise.all(alarms.map(async (alarm) => ({ key: await alarmKey(alarm.id), triggerAt: alarm.triggerAt, armed: alarm.armed })));
      await runDevice(shard, route.installId, secretHash, { kind: "alarms", alarms: hashed });
      return json(204);
    }
    if (route.kind === "synced") {
      const body = await readJson(request, MAX_API_BODY_BYTES);
      if (body && typeof body === "object" && "receiptVersion" in body) {
        const {alarms, ...receipt} = validateReceipt(body, nowMs);
        const hashed = await Promise.all(alarms.map(async a => ({key: await alarmKey(a.id), triggerAt: a.triggerAt, armed: a.armed})));
        await runDevice(shard, route.installId, secretHash, {kind: "receipt", receipt, alarms: hashed});
      } else {
        const syncedAt = validateSynced(body, nowMs);
        await runDevice(shard, route.installId, secretHash, { kind: "synced", syncedAt });
      }
      return json(204);
    }
    if (method === "PUT") return await putSubscription(env, shard, route, request, secretHash);
    const key = await subscriptionKey(route.provider, route.subscriptionId);
    await runDevice(shard, route.installId, secretHash, { kind: "deleteSubscription", key });
    // Owner-checked, so this never removes another install's entry.
    await releaseIndexEntries(env, [{ key, installId: route.installId }]);
    return json(204);
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error);
    log("error", "Device API request failed", { route: route.kind, error: errorName(error) });
    return json(500, { error: "server error" });
  }
}

async function googleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return json(405, { error: "method not allowed" }, { allow: "POST" });
  const channelId = request.headers.get("x-goog-channel-id");
  if (!validProviderId(channelId)) return json(400, { error: "X-Goog-Channel-ID required" });
  try {
    const key = await subscriptionKey("google", channelId);
    const index = await indexShard(env, key);
    const installId = (await index.indexLookup([key]))[key];
    if (!installId) return json(204);
    const token = request.headers.get("x-goog-channel-token");
    const outcome = await (await installShard(env, installId)).googleNotify({
      installId,
      key,
      tokenHash: token ? await sha256Hex(token) : null,
      resourceIdHash: await sha256Hex(request.headers.get("x-goog-resource-id") ?? ""),
      state: request.headers.get("x-goog-resource-state") ?? "",
    });
    if (outcome === "missing") ctx.waitUntil(index.indexRelease([{ key, installId }], INDEX_RELEASE_GRACE_MS));
    if (outcome === "forbidden") {
      log("warn", "Google webhook channel token mismatch");
      return json(403, { error: "invalid channel token" });
    }
    return json(204);
  } catch (error) {
    log("error", "Google webhook processing failed", { error: errorName(error) });
    return json(500, { error: "server error" });
  }
}

interface GraphNotification {
  subscriptionId: string;
  clientState: string;
  lifecycleEvent?: unknown;
}

async function microsoftWebhook(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const method = request.method.toUpperCase();
  const validationToken = url.searchParams.get("validationToken");
  // Graph validates notification and lifecycle URLs with a POST (older docs: GET) carrying
  // ?validationToken=; it must be echoed as text/plain within 10 seconds.
  if (validationToken !== null && (method === "POST" || method === "GET")) {
    if (validationToken.length === 0 || validationToken.length > 2048) return text(400, "invalid validationToken");
    return text(200, validationToken);
  }
  if (method !== "POST") return json(405, { error: "method not allowed" }, { allow: "POST" });
  try {
    const body = await readJson(request, MAX_WEBHOOK_BODY_BYTES) as { value?: unknown };
    if (!body || typeof body !== "object" || !Array.isArray(body.value) || body.value.length > MAX_GRAPH_NOTIFICATIONS) {
      throw new HttpError(400, "notification body must contain a value array");
    }
    const notifications = (body.value as unknown[]).filter((item): item is GraphNotification => {
      const candidate = item as Partial<GraphNotification> | null;
      return !!candidate && typeof candidate === "object" && validProviderId(candidate.subscriptionId) && typeof candidate.clientState === "string";
    });
    const keyed = await Promise.all(notifications.map(async (notification) => ({
      notification,
      key: await subscriptionKey("microsoft", notification.subscriptionId),
    })));
    const keys = [...new Set(keyed.map((entry) => entry.key))];
    if (keys.length > MAX_GRAPH_SUBSCRIPTIONS_PER_REQUEST) {
      throw new HttpError(400, `at most ${MAX_GRAPH_SUBSCRIPTIONS_PER_REQUEST} distinct subscriptions per request`);
    }

    // 1. Index lookups, one call per index shard.
    const keysByIndex = new Map<string, string[]>();
    for (const key of keys) {
      const name = await shardFor(`subscription:${key}`);
      if (!keysByIndex.has(name)) keysByIndex.set(name, []);
      keysByIndex.get(name)?.push(key);
    }
    const owners: Record<string, string> = {};
    await Promise.all([...keysByIndex].map(async ([name, group]) => {
      Object.assign(owners, await env.SHARDS.getByName(name).indexLookup(group));
    }));

    // 2. One call per install shard; the shard verifies clientState and records the work.
    const itemsByShard = new Map<string, GraphItem[]>();
    for (const { notification, key } of keyed) {
      const installId = owners[key];
      if (!installId) continue;
      const name = await shardFor(`install:${installId}`);
      if (!itemsByShard.has(name)) itemsByShard.set(name, []);
      itemsByShard.get(name)?.push({
        installId,
        key,
        clientStateHash: await sha256Hex(notification.clientState),
        lifecycleEvent: typeof notification.lifecycleEvent === "string" ? notification.lifecycleEvent : null,
      });
    }
    let mismatches = 0;
    let late = 0;
    const missing: Array<{ key: string; installId: string }> = [];
    await Promise.all([...itemsByShard].map(async ([name, items]) => {
      const outcome = await env.SHARDS.getByName(name).graphNotify(items);
      mismatches += outcome.mismatches;
      late += outcome.late;
      missing.push(...outcome.missing);
    }));
    if (mismatches > 0) log("warn", "Graph notifications with a mismatched clientState were ignored", { count: mismatches });
    if (late > 0) log("info", "Graph lifecycle events after the recorded expiry were routed", { count: late });
    if (missing.length > 0) ctx.waitUntil(releaseIndexEntries(env, missing, INDEX_RELEASE_GRACE_MS));
    // Graph wants an answer within about 3 seconds: pushes go out from the shard alarms.
    return json(202);
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error);
    log("error", "Microsoft webhook processing failed", { error: errorName(error) });
    return json(500, { error: "server error" });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/webhooks/google") return googleWebhook(request, env, ctx);
    if (url.pathname === "/webhooks/microsoft") return microsoftWebhook(request, env, ctx, url);
    if (url.pathname.startsWith("/v2/")) return deviceApi(request, env, url);
    return json(404, { error: "not found" });
  },
} satisfies ExportedHandler<Env>;

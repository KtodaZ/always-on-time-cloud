import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";

import { APP_CHECK_JWKS_URL, resetAppCheckCache } from "../src/appcheck";
import { resetApnsCache } from "../src/apns";
import { resetSharedTokenCache } from "../src/apns-token";
import type { InstallShard } from "../src/shard";
import { sha256Hex, shardFor, subscriptionKey } from "../src/util";

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
// 09:00 in Los Angeles. Tests run in fake time years ahead, so a DO alarm set from fake time is in
// the real future and never fires by itself; tests run alarms explicitly.
export const START = Date.parse("2030-10-07T16:00:00.000Z");
export const PROJECT_NUMBER = "1054144143721";
export const APP_ID = "1:1054144143721:ios:20196992cb6f6edb9f5df8";
export const APNS_TOKEN = "ab".repeat(32);
export const FRESHNESS = { polling: false, activeHours: { start: "06:00", end: "23:00" }, timeZone: "America/Los_Angeles" };
export const POLLING = { ...FRESHNESS, polling: true };
export const CHANNEL_TOKEN = "google-channel-token-with-plenty-of-entropy";
export const RESOURCE_ID = "resource-123";
export const CLIENT_STATE = "graph-client-state-with-plenty-of-entropy";

let counter = 0;

function randomId(length: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => alphabet[byte % 64]).join("");
}

export interface ApnsCall {
  url: string;
  headers: Record<string, string>;
  body: { aps: Record<string, unknown>; aot: { v: number; kind: string; provider?: string; at: number } };
}

type ApnsResult = { status: number; reason?: string } | Error;
type ApnsResponder = (call: ApnsCall, index: number) => ApnsResult | Promise<ApnsResult>;

export interface Harness {
  installId: string;
  secret: string;
  ip: string;
  apnsToken: string;
  /** APNs requests for this harness's device token. */
  readonly apns: ApnsCall[];
  /** Every APNs request the mock saw. */
  allApns: ApnsCall[];
  jwksFetches: number;
  /** HTTP status the mocked JWKS endpoint answers with. */
  jwksStatus: number;
  respond: ApnsResponder;
  appCheck(claims?: Record<string, unknown>, options?: { kid?: string; key?: CryptoKey }): Promise<string>;
  now(): number;
  setNow(ms: number): void;
  advance(ms: number): void;
  api(method: string, path: string, options?: { body?: unknown; auth?: string | null; appCheck?: string | null; headers?: Record<string, string>; ip?: string }): Promise<Response>;
  register(overrides?: Record<string, unknown>, options?: { appCheck?: string | null; ip?: string }): Promise<Response>;
  update(overrides?: Record<string, unknown>): Promise<Response>;
  putAlarms(alarms: Array<{ id: string; triggerAtMs: number }>): Promise<Response>;
  synced(syncedAtMs: number): Promise<Response>;
  putGoogle(channelId: string, expiresAtMs?: number, overrides?: Record<string, unknown>): Promise<Response>;
  putGraph(subscriptionId: string, expiresAtMs?: number): Promise<Response>;
  google(channelId: string, headers?: Record<string, string>): Promise<Response>;
  graph(value: unknown[]): Promise<Response>;
  shard(installId?: string): Promise<DurableObjectStub<InstallShard>>;
  /** Runs the install shard's alarm if one is due by the fake clock; returns whether it ran. */
  tick(installId?: string): Promise<boolean>;
  alarmAt(installId?: string): Promise<number | null>;
  row(installId?: string): Promise<Record<string, unknown> | null>;
  sql<T = Record<string, unknown>>(stub: DurableObjectStub<InstallShard>, query: string, ...params: unknown[]): Promise<T[]>;
  kinds(): string[];
}

let rsa: CryptoKeyPair | null = null;

async function rsaKeys(): Promise<CryptoKeyPair> {
  rsa ??= await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  return rsa;
}

function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function signJwt(header: Record<string, unknown>, claims: Record<string, unknown>, key: CryptoKey): Promise<string> {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input)));
  return `${input}.${b64url(signature)}`;
}

/**
 * Fake clock, mocked APNs and App Check JWKS, and shortcuts for the device API. Each harness gets
 * its own install ID and client IP so tests never share state.
 */
export async function harness({ freshness = FRESHNESS }: { freshness?: typeof FRESHNESS } = {}): Promise<Harness> {
  counter += 1;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  resetAppCheckCache();
  resetApnsCache();
  resetSharedTokenCache();
  const keys = await rsaKeys();
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey) as JsonWebKey;

  const h: Harness = {
    installId: randomId(22),
    secret: randomId(43),
    ip: `198.51.${Math.floor(counter / 250)}.${counter % 250}`,
    apnsToken: [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    get apns() {
      return h.allApns.filter((call) => call.url.endsWith(`/3/device/${h.apnsToken}`));
    },
    allApns: [],
    jwksFetches: 0,
    jwksStatus: 200,
    respond: () => ({ status: 200 }),
    async appCheck(claims = {}, options = {}) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      return signJwt(
        { alg: "RS256", typ: "JWT", kid: options.kid ?? "test-kid" },
        { iss: `https://firebaseappcheck.googleapis.com/${PROJECT_NUMBER}`, aud: [`projects/${PROJECT_NUMBER}`, "projects/always-on-time-zombit-2026"], sub: APP_ID, iat: nowSeconds, exp: nowSeconds + 3600, ...claims },
        options.key ?? keys.privateKey,
      );
    },
    now: () => Date.now(),
    setNow: (ms) => vi.setSystemTime(ms),
    advance: (ms) => vi.setSystemTime(Date.now() + ms),
    async api(method, path, { body, auth, appCheck, headers = {}, ip } = {}) {
      const token = appCheck === undefined ? undefined : appCheck;
      return exports.default.fetch(`https://relay.test${path}`, {
        method,
        headers: {
          "cf-connecting-ip": ip ?? h.ip,
          ...(token ? { "x-firebase-appcheck": token } : {}),
          ...((auth === undefined ? h.secret : auth) ? { authorization: `Bearer ${auth === undefined ? h.secret : auth}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
    },
    async register(overrides = {}, options = {}) {
      const appCheck = options.appCheck === undefined ? await h.appCheck() : options.appCheck;
      return h.api("POST", "/v2/installations", {
        auth: null,
        appCheck,
        ip: options.ip,
        body: { installId: h.installId, installSecret: h.secret, apnsToken: h.apnsToken, environment: "development", freshness, ...overrides },
      });
    },
    update(overrides = {}) {
      return h.api("PUT", `/v2/installations/${h.installId}`, { body: { apnsToken: h.apnsToken, environment: "development", freshness, ...overrides } });
    },
    putAlarms(alarms) {
      return h.api("PUT", `/v2/installations/${h.installId}/alarms`, { body: { alarms } });
    },
    synced(syncedAtMs) {
      return h.api("POST", `/v2/installations/${h.installId}/synced`, { body: { syncedAtMs } });
    },
    async putGoogle(channelId, expiresAtMs = Date.now() + 7 * DAY, overrides = {}) {
      return h.api("PUT", `/v2/installations/${h.installId}/subscriptions/google/${encodeURIComponent(channelId)}`, {
        body: { resourceId: RESOURCE_ID, expiresAtMs, channelTokenHash: await sha256Hex(CHANNEL_TOKEN), ...overrides },
      });
    },
    async putGraph(subscriptionId, expiresAtMs = Date.now() + 3 * DAY) {
      return h.api("PUT", `/v2/installations/${h.installId}/subscriptions/microsoft/${encodeURIComponent(subscriptionId)}`, {
        body: { expiresAtMs, clientStateHash: await sha256Hex(CLIENT_STATE) },
      });
    },
    google(channelId, headers = {}) {
      return exports.default.fetch("https://relay.test/webhooks/google", {
        method: "POST",
        headers: {
          "x-goog-channel-id": channelId,
          "x-goog-channel-token": CHANNEL_TOKEN,
          "x-goog-resource-id": RESOURCE_ID,
          "x-goog-resource-state": "exists",
          "x-goog-message-number": "2",
          ...headers,
        },
      });
    },
    graph(value) {
      return exports.default.fetch("https://relay.test/webhooks/microsoft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      });
    },
    async shard(installId = h.installId) {
      return env.SHARDS.getByName(await shardFor(`install:${installId}`));
    },
    async tick(installId = h.installId) {
      return tickShard(await h.shard(installId));
    },
    async alarmAt(installId = h.installId) {
      return runInDurableObject(await h.shard(installId), (_instance, state) => state.storage.getAlarm());
    },
    async row(installId = h.installId) {
      const rows = await h.sql(await h.shard(installId), "SELECT * FROM installs WHERE install_id = ?", installId);
      return rows[0] ?? null;
    },
    async sql<T>(stub: DurableObjectStub<InstallShard>, query: string, ...params: unknown[]) {
      return runInDurableObject(stub, (_instance, state) => state.storage.sql.exec(query, ...params as SqlStorageValue[]).toArray() as T[]);
    },
    kinds: () => h.apns.map((call) => call.body.aot.kind),
  };

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === APP_CHECK_JWKS_URL) {
      h.jwksFetches += 1;
      if (h.jwksStatus !== 200) return new Response("unavailable", { status: h.jwksStatus });
      return Response.json({ keys: [{ ...jwk, kid: "test-kid", alg: "RS256", use: "sig" }] }, { headers: { "cache-control": "public, max-age=21600" } });
    }
    if (request.url.startsWith("https://api.sandbox.push.apple.com/") || request.url.startsWith("https://api.push.apple.com/")) {
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => { headers[name] = value; });
      const call: ApnsCall = { url: request.url, headers, body: await request.json() };
      h.allApns.push(call);
      const mine = call.url.endsWith(`/3/device/${h.apnsToken}`);
      const result = mine ? await h.respond(call, h.apns.length) : { status: 200 };
      if (result instanceof Error) throw result;
      return new Response(result.status === 200 ? null : JSON.stringify({ reason: result.reason }), { status: result.status });
    }
    throw new Error(`unexpected fetch ${request.url}`);
  });
  return h;
}

/** Runs a shard's alarm if it is due by the fake clock; returns whether it ran. */
export async function tickShard(stub: DurableObjectStub<InstallShard>): Promise<boolean> {
  const at = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
  if (at === null || at > Date.now()) return false;
  return runDurableObjectAlarm(stub);
}

export { subscriptionKey, sha256Hex, shardFor };

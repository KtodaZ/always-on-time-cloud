import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApnsConfigError, apnsPriority, buildPayload, resetApnsCache, sendRelayPush, signProviderToken, validateApnsConfig } from "../src/apns";
import { resetSharedTokenCache, sharedProviderToken } from "../src/apns-token";

const MINUTE = 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetApnsCache();
  resetSharedTokenCache();
});

function config() {
  return validateApnsConfig({ keyPem: env.APNS_AUTH_KEY_P8, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, topic: env.APNS_TOPIC });
}

function decode(segment: string): Uint8Array {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (segment.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function publicKey(): Promise<CryptoKey> {
  const pem = env.APNS_AUTH_KEY_P8.replace(/-----(BEGIN|END) PRIVATE KEY-----|\s/g, "");
  const privateKey = await crypto.subtle.importKey("pkcs8", decode(pem), { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", privateKey) as JsonWebKey;
  delete jwk.d;
  jwk.key_ops = ["verify"];
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

/** A fresh authority per test, so stored tokens never leak between tests. */
function authorityName(): string {
  return `test-${crypto.randomUUID()}`;
}

describe("APNs provider token", () => {
  it("is an ES256 JWT with kid and iss that verifies with the key", async () => {
    const at = Date.parse("2030-01-01T00:00:00Z");
    const token = await signProviderToken(config(), at);
    const [header, claims, signature] = token.split(".");
    expect(JSON.parse(new TextDecoder().decode(decode(header)))).toEqual({ alg: "ES256", kid: "98YK9VVN67" });
    expect(JSON.parse(new TextDecoder().decode(decode(claims)))).toEqual({ iss: "LRTR5A87Y6", iat: at / 1000 });
    expect(decode(signature)).toHaveLength(64);
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await publicKey(), decode(signature), new TextEncoder().encode(`${header}.${claims}`));
    expect(valid).toBe(true);
  });

  it("is one token shared by every caller, renewed only at 40 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2030-01-01T00:00:00Z"));
    const name = authorityName();
    const authority = env.APNS_TOKEN.getByName(name);
    const signSpy = vi.spyOn(crypto.subtle, "sign");
    // Simulate many shards in separate isolates: each source with an empty isolate cache.
    const tokens = await Promise.all(Array.from({ length: 10 }, async () => {
      resetSharedTokenCache();
      return sharedProviderToken(env, Date.now, name).get();
    }));
    expect(new Set(tokens).size).toBe(1);
    const first = tokens[0];
    expect((await authority.current()).token).toBe(first);

    vi.setSystemTime(Date.now() + 39 * MINUTE);
    resetSharedTokenCache();
    expect(await sharedProviderToken(env, Date.now, name).get()).toBe(first);
    vi.setSystemTime(Date.now() + 2 * MINUTE);
    resetSharedTokenCache();
    const second = await sharedProviderToken(env, Date.now, name).get();
    expect(second).not.toBe(first);
    expect((await authority.current()).token).toBe(second);
    // 10 concurrent callers, 41 minutes: exactly 2 signatures.
    expect(signSpy.mock.calls.filter(([algorithm]) => (algorithm as { name: string }).name === "ECDSA")).toHaveLength(2);
  });

  it("is cached in the isolate until it is 40 minutes old", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2030-02-01T00:00:00Z"));
    const name = authorityName();
    const source = sharedProviderToken(env, Date.now, name);
    const first = await source.get();
    const getByName = vi.spyOn(env.APNS_TOKEN, "getByName");
    vi.setSystemTime(Date.now() + 39 * MINUTE);
    expect(await source.get()).toBe(first);
    expect(getByName).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 2 * MINUTE);
    expect(await source.get()).not.toBe(first);
    expect(getByName).toHaveBeenCalledTimes(1);
  });

  it("replaces a rejected token only once it is 20 minutes old, for every caller", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2030-03-01T00:00:00Z"));
    const name = authorityName();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ reason: "ExpiredProviderToken" }), { status: 403 }));
    const source = sharedProviderToken(env, Date.now, name);
    const first = await source.get();
    const request = { environment: "production" as const, token: "ab".repeat(32), kind: "change" as const, at: Date.now() };
    expect(await sendRelayPush(config(), source, request)).toEqual({ status: 403, reason: "ExpiredProviderToken" });
    expect(await source.get()).toBe(first);
    vi.setSystemTime(Date.now() + 21 * MINUTE);
    await sendRelayPush(config(), source, request);
    const second = await source.get();
    expect(second).not.toBe(first);
    // Another isolate sees the replacement too, and a stale report does not replace it again.
    resetSharedTokenCache();
    const other = sharedProviderToken(env, Date.now, name);
    expect(await other.get()).toBe(second);
    vi.setSystemTime(Date.now() + 21 * MINUTE);
    await other.rejected(first);
    expect(await other.get()).toBe(second);
    expect(fetchSpy.mock.calls.map(([, init]) => (init?.headers as Record<string, string>).authorization)).toEqual([`bearer ${first}`, `bearer ${first}`]);
  });

  it("rejects bad configuration", () => {
    expect(() => validateApnsConfig({ keyPem: "", keyId: "98YK9VVN67", teamId: "LRTR5A87Y6", topic: "a.b" })).toThrow(ApnsConfigError);
    expect(() => validateApnsConfig({ keyPem: env.APNS_AUTH_KEY_P8, keyId: "short", teamId: "LRTR5A87Y6", topic: "a.b" })).toThrow(ApnsConfigError);
    expect(() => validateApnsConfig({ keyPem: env.APNS_AUTH_KEY_P8, keyId: "98YK9VVN67", teamId: "LRTR5A87Y6", topic: "nodots" })).toThrow(ApnsConfigError);
  });
});

describe("payload", () => {
  it("has exactly the documented keys and priorities", () => {
    expect(JSON.parse(buildPayload("renew", undefined, 5))).toEqual({
      aps: { alert: { title: "Keeping your alarms up to date", body: "Checking for calendar updates." }, "mutable-content": 1, "interruption-level": "passive" },
      aot: { v: 1, kind: "renew", at: 5 },
    });
    expect(["heartbeat", "precheck", "change", "renew"].map((kind) => apnsPriority(kind as "heartbeat"))).toEqual(["5", "10", "10", "10"]);
  });
});

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApnsConfigError, apnsPriority, buildPayload, providerToken, resetApnsCache, sendRelayPush, validateApnsConfig } from "../src/apns";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetApnsCache();
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

describe("APNs provider token", () => {
  it("is an ES256 JWT with kid and iss that verifies with the key, reused for 40 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2030-01-01T00:00:00Z"));
    const token = await providerToken(config());
    const [header, claims, signature] = token.split(".");
    expect(JSON.parse(new TextDecoder().decode(decode(header)))).toEqual({ alg: "ES256", kid: "98YK9VVN67" });
    expect(JSON.parse(new TextDecoder().decode(decode(claims)))).toEqual({ iss: "LRTR5A87Y6", iat: Date.parse("2030-01-01T00:00:00Z") / 1000 });
    expect(decode(signature)).toHaveLength(64);
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await publicKey(), decode(signature), new TextEncoder().encode(`${header}.${claims}`));
    expect(valid).toBe(true);

    vi.setSystemTime(Date.now() + 39 * 60 * 1000);
    expect(await providerToken(config())).toBe(token);
    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    expect(await providerToken(config())).not.toBe(token);
  });

  it("drops a rejected token only after 20 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2030-01-01T00:00:00Z"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ reason: "ExpiredProviderToken" }), { status: 403 }));
    const first = await providerToken(config());
    const request = { environment: "production" as const, token: "ab".repeat(32), kind: "change" as const, at: Date.now() };
    expect(await sendRelayPush(config(), request)).toEqual({ status: 403, reason: "ExpiredProviderToken" });
    expect(await providerToken(config())).toBe(first);
    vi.setSystemTime(Date.now() + 21 * 60 * 1000);
    await sendRelayPush(config(), request);
    expect(await providerToken(config())).not.toBe(first);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
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

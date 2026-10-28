// APNs token-based delivery over the Workers fetch API (HTTP/2 to Apple). The provider token is an
// ES256 JWT signed with WebCrypto. One token is shared by every shard (see apns-token.ts), so the
// relay stays well inside Apple's limit on provider token updates.

import type { Provider, PushKind } from "./schedule";

export const APNS_HOSTS = Object.freeze({
  development: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
});
export type ApnsEnvironment = keyof typeof APNS_HOSTS;

export const PAYLOAD_VERSION = 1;
export const MAX_PAYLOAD_BYTES = 4096;
/** Every relay push replaces the same quiet notification on the device. */
export const SYNC_COLLAPSE_ID = "aot-sync";
/** APNs keeps only the newest undelivered notification per collapse ID, so a long expiry is free. */
export const TTL_SECONDS = 24 * 60 * 60;
// Apple rejects provider tokens older than an hour and throttles refreshes faster than every 20 min.
export const PROVIDER_TOKEN_MAX_AGE_MS = 40 * 60 * 1000;
export const PROVIDER_TOKEN_MIN_AGE_MS = 20 * 60 * 1000;
const PROVIDER_TOKEN_ERRORS = new Set(["ExpiredProviderToken", "InvalidProviderToken"]);
const REQUEST_TIMEOUT_MS = 10_000;

export interface ApnsConfig {
  keyPem: string;
  keyId: string;
  teamId: string;
  topic: string;
}

export interface ApnsResult {
  status: number;
  reason?: string;
}

export class ApnsConfigError extends Error {
  override name = "ApnsConfigError";
}

export function validateApnsConfig(config: Partial<ApnsConfig>): ApnsConfig {
  if (typeof config.keyPem !== "string" || !config.keyPem.includes("PRIVATE KEY")) throw new ApnsConfigError("APNS_AUTH_KEY_P8 is missing");
  if (!/^[A-Z0-9]{10}$/.test(config.keyId ?? "")) throw new ApnsConfigError("APNS_KEY_ID must be 10 uppercase alphanumerics");
  if (!/^[A-Z0-9]{10}$/.test(config.teamId ?? "")) throw new ApnsConfigError("APNS_TEAM_ID must be 10 uppercase alphanumerics");
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(config.topic ?? "")) throw new ApnsConfigError("APNS_TOPIC must be the app bundle identifier");
  return config as ApnsConfig;
}

export function buildPayload(kind: PushKind, provider: Provider | undefined, at: number, deliveryId?: string): string {
  const body = JSON.stringify({
    aps: {
      alert: { title: "Keeping your alarms up to date", body: "Checking for calendar updates." },
      "mutable-content": 1,
      "interruption-level": "passive",
    },
    aot: { v: PAYLOAD_VERSION, kind, ...(provider ? { provider } : {}), at, ...(deliveryId ? {deliveryId} : {}) },
  });
  if (new TextEncoder().encode(body).length > MAX_PAYLOAD_BYTES) throw new TypeError("APNs payload exceeds 4 KB");
  return body;
}

export function apnsPriority(kind: PushKind): "5" | "10" {
  return kind === "heartbeat" ? "5" : "10";
}

function base64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const base64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

let signingKeyCache: { fingerprint: string; key: CryptoKey } | null = null;

/** Identifies the configured key, so a rotated key never reuses a token signed by the old one. */
export function keyFingerprint(config: ApnsConfig): string {
  return `${config.keyId}:${config.teamId}:${config.keyPem.length}:${config.keyPem.slice(-24)}`;
}

async function signingKey(config: ApnsConfig): Promise<CryptoKey> {
  const fingerprint = keyFingerprint(config);
  if (signingKeyCache?.fingerprint === fingerprint) return signingKeyCache.key;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(config.keyPem), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } catch {
    throw new ApnsConfigError("APNS_AUTH_KEY_P8 is not a readable EC P-256 private key");
  }
  signingKeyCache = { fingerprint, key };
  return key;
}

/** Signs a new ES256 provider token {alg, kid}.{iss, iat}. Callers cache it (apns-token.ts). */
export async function signProviderToken(config: ApnsConfig, nowMs = Date.now()): Promise<string> {
  const key = await signingKey(config);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(nowMs / 1000) }));
  const input = `${header}.${claims}`;
  // WebCrypto ECDSA signatures are already IEEE P1363 (r || s), the JOSE format.
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input)));
  return `${input}.${base64url(signature)}`;
}

/** Where a sender gets the provider token, and reports one APNs rejected as expired or invalid. */
export interface ProviderTokenSource {
  get(): Promise<string>;
  rejected(token: string): Promise<void>;
}

/** Test hook: forget the imported signing key. */
export function resetApnsCache(): void {
  signingKeyCache = null;
}

export interface PushRequest {
  environment: ApnsEnvironment;
  token: string;
  kind: PushKind;
  provider?: Provider;
  at: number;
  deliveryId?: string;
}

/**
 * Sends one relay push. Resolves with APNs's status and reason (200 means APNs accepted it). A
 * request that fails before APNs answers is retried once; the shared collapse ID makes a duplicate
 * harmless. Rejects for configuration errors and transport failures.
 */
export async function sendRelayPush(config: ApnsConfig, tokens: ProviderTokenSource, request: PushRequest): Promise<ApnsResult> {
  if (!Object.hasOwn(APNS_HOSTS, request.environment)) throw new TypeError("invalid APNs environment");
  if (!/^[0-9a-f]{64,200}$/.test(request.token)) throw new TypeError("invalid APNs token");
  const body = buildPayload(request.kind, request.provider, request.at, request.deliveryId);
  const url = `${APNS_HOSTS[request.environment]}/3/device/${request.token}`;
  const providerToken = await tokens.get();
  const headers = {
    authorization: `bearer ${providerToken}`,
    "content-type": "application/json",
    "apns-push-type": "alert",
    "apns-priority": apnsPriority(request.kind),
    "apns-collapse-id": SYNC_COLLAPSE_ID,
    "apns-topic": config.topic,
    "apns-id": crypto.randomUUID(),
    "apns-expiration": String(Math.floor(request.at / 1000) + TTL_SECONDS),
  };
  let response: Response | undefined;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      break;
    } catch (error) {
      if (attempt > 0) throw error;
    }
  }
  let reason: string | undefined;
  if (response.status !== 200) {
    const text = (await response.text()).slice(0, 8192);
    try {
      const parsed = JSON.parse(text) as { reason?: unknown };
      reason = typeof parsed.reason === "string" ? parsed.reason : undefined;
    } catch {
      reason = "UnparseableResponse";
    }
  } else {
    await response.body?.cancel();
  }
  if (response.status === 403 && reason && PROVIDER_TOKEN_ERRORS.has(reason)) {
    // Best effort: if the report fails, the token is replaced at its normal age anyway.
    await tokens.rejected(providerToken).catch(() => undefined);
  }
  return { status: response.status, ...(reason ? { reason } : {}) };
}

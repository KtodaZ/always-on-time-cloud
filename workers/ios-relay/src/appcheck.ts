// Firebase App Check token verification (RS256 JWTs signed by Firebase), following
// https://firebase.google.com/docs/app-check/custom-resource-backend: signature against the public
// JWKS, issuer and audience naming the project number, and the app ID as subject.

export const APP_CHECK_JWKS_URL = "https://firebaseappcheck.googleapis.com/v1/jwks";
const JWKS_DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const JWKS_MIN_REFRESH_MS = 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 4096;

export interface AppCheckConfig {
  projectNumber: string;
  appIds: string[];
}

interface JwksCache {
  keys: Map<string, CryptoKey>;
  fetchedAtMs: number;
  maxAgeMs: number;
}

let jwksCache: JwksCache | null = null;
let lastFetchAttemptMs = 0;

/** Test hook: forget cached keys. */
export function resetAppCheckCache(): void {
  jwksCache = null;
  lastFetchAttemptMs = 0;
}

function base64urlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("invalid base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeJson(segment: string): Record<string, unknown> {
  const value = JSON.parse(new TextDecoder().decode(base64urlDecode(segment))) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JWT segment is not an object");
  return value as Record<string, unknown>;
}

async function fetchJwks(nowMs: number): Promise<JwksCache> {
  lastFetchAttemptMs = nowMs;
  const response = await fetch(APP_CHECK_JWKS_URL, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`App Check JWKS returned HTTP ${response.status}`);
  const body = (await response.json()) as { keys?: Array<Record<string, unknown>> };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== "RSA" || typeof jwk.kid !== "string" || typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    keys.set(jwk.kid, key);
  }
  const maxAge = /max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1];
  const maxAgeMs = maxAge ? Math.min(Number(maxAge) * 1000, JWKS_DEFAULT_MAX_AGE_MS) : JWKS_DEFAULT_MAX_AGE_MS;
  return { keys, fetchedAtMs: nowMs, maxAgeMs };
}

async function keyFor(kid: string, nowMs: number): Promise<CryptoKey | undefined> {
  const stale = !jwksCache || nowMs - jwksCache.fetchedAtMs >= jwksCache.maxAgeMs;
  const unknownKid = jwksCache && !jwksCache.keys.has(kid) && nowMs - lastFetchAttemptMs >= JWKS_MIN_REFRESH_MS;
  if (stale || unknownKid) {
    try {
      jwksCache = await fetchJwks(nowMs);
    } catch (error) {
      // Keep using the previous keys if Google is briefly unreachable.
      if (!jwksCache) throw error;
    }
  }
  return jwksCache?.keys.get(kid);
}

/**
 * Resolves true for a valid App Check token for one of the configured apps, false for an invalid
 * one. Rejects only when the signing keys cannot be fetched at all.
 */
export async function verifyAppCheckToken(token: string, config: AppCheckConfig, nowMs = Date.now()): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  let signature: Uint8Array;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
    signature = base64urlDecode(parts[2]);
  } catch {
    return false;
  }
  if (header.alg !== "RS256" || header.typ !== "JWT" || typeof header.kid !== "string") return false;

  const nowSeconds = nowMs / 1000;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== `https://firebaseappcheck.googleapis.com/${config.projectNumber}`) return false;
  if (!audience.includes(`projects/${config.projectNumber}`)) return false;
  if (typeof claims.sub !== "string" || !config.appIds.includes(claims.sub)) return false;
  if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) return false;
  if (typeof claims.iat === "number" && claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) return false;

  const key = await keyFor(header.kid, nowMs);
  if (!key) return false;
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
}

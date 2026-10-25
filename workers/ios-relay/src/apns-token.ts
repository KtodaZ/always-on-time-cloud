// One APNs provider token for the whole relay. Apple answers TooManyProviderTokenUpdates when a key
// changes tokens too often, so a single Durable Object signs the token, keeps it in storage, and
// replaces it at 40 minutes (or after APNs rejects it, but never within 20 minutes of signing).
// Shards cache the token in isolate memory until the same 40-minute mark.

import { DurableObject } from "cloudflare:workers";

import {
  PROVIDER_TOKEN_MAX_AGE_MS,
  PROVIDER_TOKEN_MIN_AGE_MS,
  keyFingerprint,
  signProviderToken,
  validateApnsConfig,
  type ApnsConfig,
  type ProviderTokenSource,
} from "./apns";
import type { Env } from "./env";

export const APNS_TOKEN_OBJECT = "apns-provider-token";

export interface IssuedToken {
  token: string;
  issuedAtMs: number;
}

interface StoredToken extends IssuedToken {
  fingerprint: string;
}

export function apnsConfigFromEnv(env: Env): ApnsConfig {
  return validateApnsConfig({ keyPem: env.APNS_AUTH_KEY_P8, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, topic: env.APNS_TOPIC });
}

export class ApnsTokenAuthority extends DurableObject<Env> {
  private signing: Promise<IssuedToken> | null = null;

  /** Current time; a method so tests can control it. */
  protected now(): number {
    return Date.now();
  }

  private stored(fingerprint: string): StoredToken | null {
    const stored = this.ctx.storage.kv.get<StoredToken>("token");
    return stored && stored.fingerprint === fingerprint ? stored : null;
  }

  /** Signs and stores a new token; concurrent callers share one signature. */
  private renew(config: ApnsConfig): Promise<IssuedToken> {
    this.signing ??= (async () => {
      try {
        const issuedAtMs = this.now();
        const token = await signProviderToken(config, issuedAtMs);
        this.ctx.storage.kv.put<StoredToken>("token", { token, issuedAtMs, fingerprint: keyFingerprint(config) });
        return { token, issuedAtMs };
      } finally {
        this.signing = null;
      }
    })();
    return this.signing;
  }

  /** The shared token, signing a new one when there is none or it is 40 minutes old. */
  async current(): Promise<IssuedToken> {
    const config = apnsConfigFromEnv(this.env);
    const stored = this.stored(keyFingerprint(config));
    if (stored && this.now() - stored.issuedAtMs < PROVIDER_TOKEN_MAX_AGE_MS) return { token: stored.token, issuedAtMs: stored.issuedAtMs };
    return this.renew(config);
  }

  /** APNs rejected `token`: replace it if it is still current and at least 20 minutes old. */
  async rejected(token: string): Promise<IssuedToken> {
    const config = apnsConfigFromEnv(this.env);
    const stored = this.stored(keyFingerprint(config));
    if (stored && stored.token === token && this.now() - stored.issuedAtMs >= PROVIDER_TOKEN_MIN_AGE_MS) return this.renew(config);
    return this.current();
  }
}

let isolateCache: IssuedToken | null = null;
let pending: Promise<IssuedToken> | null = null;

/** Test hook: forget the token cached in this isolate. */
export function resetSharedTokenCache(): void {
  isolateCache = null;
  pending = null;
}

/** A shard's view of the shared token: cached in isolate memory, fetched from the authority. */
export function sharedProviderToken(env: Env, now: () => number = Date.now, objectName = APNS_TOKEN_OBJECT): ProviderTokenSource {
  const authority = () => env.APNS_TOKEN.getByName(objectName);
  const remember = (issued: IssuedToken) => {
    if (!isolateCache || issued.issuedAtMs >= isolateCache.issuedAtMs) isolateCache = issued;
    return issued;
  };
  return {
    async get() {
      if (isolateCache && now() - isolateCache.issuedAtMs < PROVIDER_TOKEN_MAX_AGE_MS) return isolateCache.token;
      pending ??= authority().current().then(remember).finally(() => {
        pending = null;
      });
      return (await pending).token;
    },
    async rejected(token) {
      if (isolateCache?.token === token) isolateCache = null;
      remember(await authority().rejected(token));
    },
  };
}

// HTTP helpers and request validation for the device API and webhooks.

import { canonicalTimeZone, type Freshness, type Provider } from "./schedule";
import type { ApnsEnvironment } from "./apns";

export const MAX_API_BODY_BYTES = 32 * 1024;
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
export const MAX_ALARMS_PER_INSTALL = 128;
export const MAX_ALARM_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_SUBSCRIPTION_HORIZON_MS = 366 * 24 * 60 * 60 * 1000;
/** A reported sync may be at most this far ahead of the server clock. */
export const SYNC_CLOCK_SKEW_MS = 60 * 1000;

export const INSTALL_ID = /^[A-Za-z0-9_-]{22}$/;
export const INSTALL_SECRET = /^[A-Za-z0-9_-]{43}$/;
const APNS_TOKEN = /^[0-9a-f]{64,200}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export const PROVIDERS = new Set<Provider>(["google", "microsoft"]);
const ENVIRONMENTS = new Set<ApnsEnvironment>(["development", "production"]);

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function json(status: number, value: unknown = null, headers: Record<string, string> = {}): Response {
  const base: Record<string, string> = { "cache-control": "no-store", ...headers };
  if (value === null) return new Response(null, { status, headers: base });
  return new Response(JSON.stringify(value), { status, headers: { ...base, "content-type": "application/json; charset=utf-8" } });
}

export function text(status: number, value: string): Response {
  return new Response(value, {
    status,
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

export function errorResponse(error: HttpError, headers: Record<string, string> = {}): Response {
  return json(error.status, { error: error.message }, headers);
}

/** Reads at most `maxBytes` of the body (413 beyond) and parses it as JSON (400 if invalid or empty). */
export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, "request body too large");
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "request body too large");
      }
      chunks.push(value);
    }
  }
  if (size === 0) throw new HttpError(400, "JSON object required");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

type JsonObject = Record<string, unknown>;

export function requireObject(value: unknown, required: string[], optional: string[] = []): asserts value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "JSON object required");
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new HttpError(400, `fields do not match the schema (missing: ${missing.join(",") || "none"}; unknown: ${unknown.join(",") || "none"})`);
  }
}

/** Provider identifiers: printable ASCII, no whitespace or path separators, at most 256 chars. */
export function validProviderId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && /^[\x21-\x7e]+$/.test(value) && !/[/\\]/.test(value);
}

export function validateFreshness(value: unknown): Freshness {
  requireObject(value, ["polling", "activeHours", "timeZone"]);
  if (typeof value.polling !== "boolean") throw new HttpError(400, "freshness.polling must be a boolean");
  requireObject(value.activeHours, ["start", "end"]);
  const { start, end } = value.activeHours;
  if (typeof start !== "string" || typeof end !== "string" || !CLOCK.test(start) || !CLOCK.test(end) || start === end) {
    throw new HttpError(400, "freshness.activeHours needs distinct HH:mm start and end");
  }
  const timeZone = canonicalTimeZone(value.timeZone);
  if (timeZone === null) throw new HttpError(400, "freshness.timeZone must be an IANA time zone");
  return { polling: value.polling, activeHours: { start, end }, timeZone };
}

export interface RegistrationFields {
  apnsToken: string;
  environment: ApnsEnvironment;
  freshness: Freshness;
  receiptVersion?: 1;
  deliveryEligible?: boolean;
}

export function validateRegistrationFields(body: JsonObject): RegistrationFields {
  if (typeof body.apnsToken !== "string" || !APNS_TOKEN.test(body.apnsToken)) {
    throw new HttpError(400, "apnsToken must be 64-200 lowercase hexadecimal characters");
  }
  if (!ENVIRONMENTS.has(body.environment as ApnsEnvironment)) throw new HttpError(400, "environment must be development or production");
  if (body.receiptVersion !== undefined && body.receiptVersion !== 1) throw new HttpError(400, "unsupported receiptVersion");
  if (body.deliveryEligible !== undefined && typeof body.deliveryEligible !== "boolean") throw new HttpError(400, "invalid deliveryEligible");
  return { apnsToken: body.apnsToken, environment: body.environment as ApnsEnvironment, freshness: validateFreshness(body.freshness),
    ...(body.receiptVersion === 1 ? {receiptVersion: 1 as const} : {}),
    ...(typeof body.deliveryEligible === "boolean" ? {deliveryEligible: body.deliveryEligible} : {}) };
}

export interface RegistrationBody extends RegistrationFields {
  installId: string;
  installSecret: string;
}

export function validateRegistration(body: unknown): RegistrationBody {
  requireObject(body, ["installId", "installSecret", "apnsToken", "environment", "freshness"], ["receiptVersion", "deliveryEligible"]);
  if (typeof body.installId !== "string" || !INSTALL_ID.test(body.installId) ||
      typeof body.installSecret !== "string" || !INSTALL_SECRET.test(body.installSecret)) {
    throw new HttpError(400, "installId (22 chars) and installSecret (43 chars) must be random base64url values");
  }
  return { installId: body.installId, installSecret: body.installSecret, ...validateRegistrationFields(body) };
}

export function validateUpdate(body: unknown): RegistrationFields {
  requireObject(body, ["apnsToken", "environment", "freshness"], ["receiptVersion", "deliveryEligible"]);
  return validateRegistrationFields(body);
}

export interface AlarmInput {
  id: string;
  triggerAt: number;
  armed?: boolean;
}

/**
 * Alarm snapshot. Entries at or before `nowMs` or beyond 90 days are dropped rather than rejected,
 * so a snapshot racing an alarm's trigger still succeeds. Returns raw IDs (hashed by the caller).
 */
export function validateAlarms(body: unknown, nowMs: number): AlarmInput[] {
  requireObject(body, ["alarms"]);
  if (!Array.isArray(body.alarms) || body.alarms.length > MAX_ALARMS_PER_INSTALL) {
    throw new HttpError(400, `alarms must be an array of at most ${MAX_ALARMS_PER_INSTALL} entries`);
  }
  const seen = new Set<string>();
  const alarms: AlarmInput[] = [];
  for (const alarm of body.alarms as unknown[]) {
    requireObject(alarm, ["id", "triggerAtMs"], ["armed"]);
    if (alarm.armed !== undefined && typeof alarm.armed !== "boolean") throw new HttpError(400, "invalid armed");
    if (typeof alarm.id !== "string" || alarm.id.length < 1 || alarm.id.length > 200 || /[\u0000-\u001f]/.test(alarm.id)) {
      throw new HttpError(400, "alarm id must be an opaque string of 1 to 200 characters");
    }
    if (!Number.isSafeInteger(alarm.triggerAtMs) || (alarm.triggerAtMs as number) < 0) {
      throw new HttpError(400, "triggerAtMs must be epoch milliseconds");
    }
    if (seen.has(alarm.id)) throw new HttpError(400, "alarm ids must be unique");
    seen.add(alarm.id);
    const triggerAt = alarm.triggerAtMs as number;
    if (triggerAt > nowMs && triggerAt <= nowMs + MAX_ALARM_HORIZON_MS) alarms.push({ id: alarm.id, triggerAt, ...(typeof alarm.armed === "boolean" ? {armed: alarm.armed} : {}) });
  }
  return alarms.sort((left, right) => left.triggerAt - right.triggerAt);
}

export interface SubscriptionInput {
  provider: Provider;
  resourceId?: string;
  verificationHash: string;
  expiresAt: number;
}

export function validateSubscription(provider: Provider, body: unknown, nowMs: number): SubscriptionInput {
  const fields = provider === "google" ? ["resourceId", "expiresAtMs", "channelTokenHash"] : ["expiresAtMs", "clientStateHash"];
  requireObject(body, fields);
  const verificationHash = provider === "google" ? body.channelTokenHash : body.clientStateHash;
  if (typeof verificationHash !== "string" || !SHA256_HEX.test(verificationHash)) {
    throw new HttpError(400, `${provider === "google" ? "channelTokenHash" : "clientStateHash"} must be lowercase SHA-256 hex`);
  }
  if (provider === "google" && !validProviderId(body.resourceId)) throw new HttpError(400, "resourceId is invalid");
  const expiresAt = body.expiresAtMs;
  if (!Number.isSafeInteger(expiresAt) || (expiresAt as number) <= nowMs || (expiresAt as number) > nowMs + MAX_SUBSCRIPTION_HORIZON_MS) {
    throw new HttpError(400, "expiresAtMs must be a future epoch time within 366 days");
  }
  return {
    provider,
    ...(provider === "google" ? { resourceId: body.resourceId as string } : {}),
    verificationHash,
    expiresAt: expiresAt as number,
  };
}

/** `{"syncedAtMs": n}`; at most a minute ahead of the server clock, and clamped to it. */
export function validateSynced(body: unknown, nowMs: number): number {
  requireObject(body, ["syncedAtMs"]);
  const value = body.syncedAtMs;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new HttpError(400, "syncedAtMs must be epoch milliseconds");
  if ((value as number) > nowMs + SYNC_CLOCK_SKEW_MS) throw new HttpError(400, "syncedAtMs is in the future");
  return Math.min(value as number, nowMs);
}

export type ApiRoute =
  | { kind: "collection" }
  | { kind: "installation"; installId: string }
  | { kind: "alarms"; installId: string }
  | { kind: "synced"; installId: string }
  | { kind: "subscription"; installId: string; provider: Provider; subscriptionId: string };

export const ROUTE_METHODS: Record<ApiRoute["kind"], string[]> = {
  collection: ["POST"],
  installation: ["PUT", "DELETE"],
  alarms: ["PUT"],
  synced: ["POST"],
  subscription: ["PUT", "DELETE"],
};

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Parses a device API path (`/v2/...`), or null for anything undocumented. */
export function parseApiRoute(pathname: string): ApiRoute | null {
  if (pathname === "/v2/installations") return { kind: "collection" };
  const parts = pathname.split("/");
  if (parts.length < 4 || parts[0] !== "" || parts[1] !== "v2" || parts[2] !== "installations") return null;
  const installId = decodeSegment(parts[3]);
  if (installId === null || !INSTALL_ID.test(installId)) return null;
  if (parts.length === 4) return { kind: "installation", installId };
  if (parts.length === 5 && parts[4] === "alarms") return { kind: "alarms", installId };
  if (parts.length === 5 && parts[4] === "synced") return { kind: "synced", installId };
  if (parts.length === 7 && parts[4] === "subscriptions") {
    const provider = decodeSegment(parts[5]);
    const subscriptionId = decodeSegment(parts[6]);
    if (!PROVIDERS.has(provider as Provider) || !validProviderId(subscriptionId)) return null;
    return { kind: "subscription", installId, provider: provider as Provider, subscriptionId };
  }
  return null;
}

export function parseBearer(value: string | null): string | null {
  return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value ?? "")?.[1] ?? null;
}

/**
 * Rate-limit key for the caller's network: `CF-Connecting-IP`, which Cloudflare sets and clients
 * cannot forge. IPv6 clients are grouped by /64, since one subscriber usually controls a whole /64.
 */
export function clientNetworkKey(request: Request): string {
  let address = (request.headers.get("cf-connecting-ip") ?? "unknown").trim();
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(address)) address = address.slice(7);
  if (address.includes(":")) {
    const expanded = expandIpv6(address);
    return expanded ? `v6:${expanded.slice(0, 4).join(":")}` : `v6:${address}`;
  }
  return `v4:${address}`;
}

function expandIpv6(address: string): string[] | null {
  const bare = address.split("%")[0];
  const [head, tail = ""] = bare.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = bare.includes("::") ? (tail ? tail.split(":") : []) : [];
  if ([...headParts, ...tailParts].some((part) => !/^[0-9a-fA-F]{1,4}$/.test(part))) return null;
  const fill = bare.includes("::") ? 8 - headParts.length - tailParts.length : 0;
  const parts = [...headParts, ...Array(Math.max(fill, 0)).fill("0"), ...tailParts];
  return parts.length === 8 ? parts.map((part) => part.toLowerCase().padStart(4, "0")) : null;
}

export interface SyncReceipt {
  syncedAt: number; snapshotRevision: number; deliveryId?: string;
  calendarVerified: boolean; alarmsReconciled: boolean; nextRefreshAt: number;
  alarms: AlarmInput[];
}
export function validateReceipt(body: unknown, nowMs: number): SyncReceipt {
  requireObject(body, ["receiptVersion", "syncedAtMs", "snapshotRevision", "calendarVerified", "alarmsReconciled", "alarms", "nextRefreshAtMs"], ["deliveryId"]);
  if (body.receiptVersion !== 1 || !Number.isSafeInteger(body.snapshotRevision) || (body.snapshotRevision as number) < 1
    || typeof body.calendarVerified !== "boolean" || typeof body.alarmsReconciled !== "boolean"
    || !Number.isSafeInteger(body.nextRefreshAtMs) || (body.nextRefreshAtMs as number) < 0
    || (body.nextRefreshAtMs as number) > nowMs + MAX_ALARM_HORIZON_MS
    || (body.deliveryId !== undefined && (typeof body.deliveryId !== "string" || !/^[0-9a-f-]{36}$/.test(body.deliveryId)))) throw new HttpError(400, "invalid receipt");
  return { syncedAt: validateSynced({syncedAtMs: body.syncedAtMs}, nowMs), snapshotRevision: body.snapshotRevision as number,
    calendarVerified: body.calendarVerified, alarmsReconciled: body.alarmsReconciled, nextRefreshAt: body.nextRefreshAtMs as number,
    ...(typeof body.deliveryId === "string" ? {deliveryId: body.deliveryId} : {}), alarms: validateAlarms({alarms: body.alarms}, nowMs) };
}

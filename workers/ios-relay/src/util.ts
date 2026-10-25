// Small shared helpers: hashing, constant-time comparison, shard selection, logging.

const encoder = new TextEncoder();

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toHex(new Uint8Array(digest));
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Constant-time comparison of two lowercase SHA-256 hex strings; false for anything else. */
export function safeEqualHex(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string" || !SHA256_HEX.test(left) || !SHA256_HEX.test(right)) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < 64; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

/**
 * Number of InstallShard Durable Objects. Installs, subscription index entries and rate-limit
 * counters are spread across them by a hash of their key. Changing this moves every key to a
 * different shard, so it cannot change without a data migration.
 */
export const SHARD_COUNT = 64;

/** Shard number for a key: the first 32 bits of sha256(key), modulo SHARD_COUNT. */
export async function shardIndex(key: string): Promise<number> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(key)));
  const value = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  return value % SHARD_COUNT;
}

export function shardName(index: number): string {
  return `shard-${index}`;
}

/** Durable Object name of the shard that owns `key`. */
export async function shardFor(key: string): Promise<string> {
  return shardName(await shardIndex(key));
}

/** `<provider>_<sha256(provider:subscriptionId)>`: the stored key of a provider subscription. */
export async function subscriptionKey(provider: string, subscriptionId: string): Promise<string> {
  return `${provider}_${await sha256Hex(`${provider}:${subscriptionId}`)}`;
}

export function alarmKey(opaqueAlarmId: string): Promise<string> {
  return sha256Hex(opaqueAlarmId);
}

type LogLevel = "info" | "warn" | "error";

/** One JSON line per event. Never pass secrets, tokens or calendar data. */
export function log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, message, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function errorName(error: unknown): string {
  if (error && typeof error === "object") {
    const named = error as { code?: unknown; name?: unknown };
    if (typeof named.code === "string") return named.code;
    if (typeof named.name === "string") return named.name;
  }
  return "Error";
}

/** Runs `worker` over `items` with at most `limit` in flight. */
export async function forEachLimited<T>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

"use strict";

// OAuth clients for the assistant connector: Client ID Metadata Documents (the client_id is an
// https URL serving the client's metadata) and Dynamic Client Registration (RFC 7591) as fallback.
// Fetching a metadata document is a server-side request to a URL a stranger chose, so it only
// goes to public addresses over https, pinned to the address that was checked, with no redirects
// and small size and time limits. Only /oauth/authorize fetches; failures are remembered for ten
// minutes and fetches are capped per host and overall.
//
// A client's own name is self-asserted, so it is never shown. Clients whose metadata document is
// served from a host in BRANDED_CLIENT_HOSTS get that brand; every other client is an
// "Unverified app", identified to the user by its redirect host.

const dns = require("node:dns");
const https = require("node:https");
const net = require("node:net");
const { createHash, randomBytes, timingSafeEqual } = require("node:crypto");

const { COLLECTIONS, toMillis } = require("./assistant-data");
const { clientIdForLog, errorFields, logEvent } = require("./assistant-log");
const { sha256Hex } = require("./assistant-records");
const { cleanText } = require("./assistant-snapshot");

const CIMD_MAX_BYTES = 5 * 1024;
const CIMD_TIMEOUT_MS = 5000;
const CIMD_FRESH_MS = 24 * 60 * 60 * 1000;
const CIMD_STALE_OK_MS = 7 * 24 * 60 * 60 * 1000;
const CLIENT_IDLE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const METADATA_FAILURE_CACHE_MS = 10 * 60 * 1000;
const MAX_REDIRECT_URIS = 10;

// Hosts whose Client ID Metadata Documents name a known assistant (exact host of the client_id URL):
// claude.ai serves Claude's (https://claude.ai/oauth/...; Claude Code's is
// claude.ai/oauth/claude-code-client-metadata) and chatgpt.com serves ChatGPT's
// (https://chatgpt.com/oauth/client.json or /oauth/{callback_id}/client.json).
const BRANDED_CLIENT_HOSTS = {
  "claude.ai": { name: "Claude", assistant: "claude" },
  "chatgpt.com": { name: "ChatGPT", assistant: "chatgpt" },
};
const UNVERIFIED_NAME = "Unverified app";
const MAX_URL_LENGTH = 2048;

class ClientError extends Error {
  constructor(error, description, status = 400) {
    super(description);
    this.error = error;
    this.status = status;
  }
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const clientDocId = (clientId) => sha256(clientId);

// Everything that is not ordinary public unicast: private, loopback, link-local, CGNAT, multicast,
// documentation, benchmarking, reserved, and IPv6 forms that embed or tunnel to IPv4.
const BLOCKED = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) BLOCKED.addSubnet(address, prefix, "ipv4");
// IPv6 is limited to global unicast (2000::/3) below, which already excludes loopback, mapped
// IPv4, NAT64, link-local and unique-local space; these are the special blocks inside it.
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]]) BLOCKED.addSubnet(address, prefix, "ipv6");

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    // Only global unicast (2000::/3) is public.
    const first = Number.parseInt(address.split(":")[0] || "0", 16);
    if ((first & 0xe000) !== 0x2000) return false;
  }
  return !BLOCKED.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Throws unless `text` is an acceptable Client ID Metadata Document URL. Returns the URL. */
function parseClientIdUrl(text) {
  if (typeof text !== "string" || text.length > MAX_URL_LENGTH) throw new ClientError("invalid_client", "client_id is not a valid URL");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new ClientError("invalid_client", "client_id is not a valid URL");
  }
  const segments = url.pathname.split("/");
  if (url.protocol !== "https:" || url.username || url.password || url.hash || text.includes("#") ||
      url.port !== "" || url.pathname === "/" || segments.includes(".") || segments.includes("..") ||
      net.isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0 || !url.hostname.includes(".") || url.href !== text) {
    throw new ClientError("invalid_client", "client_id must be a plain https URL with a path on a public host name");
  }
  return url;
}

/** Resolves a host name and returns one address, refusing hosts with any non-public address. */
async function resolvePublic(hostname, lookup = dns.promises.lookup) {
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new ClientError("invalid_client", "client_id host does not resolve");
  }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new ClientError("invalid_client", "client_id host is not a public address");
  }
  return addresses[0];
}

/** GET over https to a pre-checked address. Resolves {status, headers, body: Buffer}; rejects oversize bodies. */
function httpsGet(url, { address, family }, { maxBytes = CIMD_MAX_BYTES, timeoutMs = CIMD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "AlwaysOnTime-OAuth/1" },
      // Connect to the address that was checked, never a second DNS answer (no rebinding).
      lookup: (_host, options, callback) => (options?.all ? callback(null, [{ address, family }]) : callback(null, address, family)),
      servername: url.hostname,
      timeout: timeoutMs,
      signal: AbortSignal.timeout(timeoutMs),
    }, (response) => {
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.destroy();
        reject(new ClientError("invalid_client", "client metadata document is too large"));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          reject(new ClientError("invalid_client", "client metadata document is too large"));
        } else chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new ClientError("invalid_client", "client metadata document timed out")));
    request.on("error", (error) => reject(error instanceof ClientError ? error : new ClientError("invalid_client", "client metadata document could not be fetched")));
    request.end();
  });
}

/** Fetches and parses a Client ID Metadata Document. `deps` replace DNS and the request in tests. */
async function fetchClientMetadata(clientId, { lookup, get = httpsGet } = {}) {
  const url = parseClientIdUrl(clientId);
  const address = await resolvePublic(url.hostname, lookup);
  const response = await get(url, address, { maxBytes: CIMD_MAX_BYTES, timeoutMs: CIMD_TIMEOUT_MS });
  // Redirects are refused, not followed: the document must live at the client_id itself.
  if (response.status !== 200) throw new ClientError("invalid_client", `client metadata document returned HTTP ${response.status}`);
  if (response.body.length > CIMD_MAX_BYTES) throw new ClientError("invalid_client", "client metadata document is too large");
  const type = String(response.headers?.["content-type"] ?? "");
  if (type && !/^application\/([a-z.+-]*\+)?json\b/i.test(type)) throw new ClientError("invalid_client", "client metadata document is not JSON");
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch {
    throw new ClientError("invalid_client", "client metadata document is not JSON");
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Registered redirect URIs: https anywhere, or http only on loopback (native and desktop clients). */
function isValidRedirectUri(text) {
  if (typeof text !== "string" || text.length > MAX_URL_LENGTH || text.includes("#")) return false;
  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return url.hostname.length > 0;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/** Exact match, except that loopback http URIs may use any port (RFC 8252 section 7.3). */
function redirectMatches(registered, requested) {
  if (registered === requested) return true;
  if (!isValidRedirectUri(registered) || !isValidRedirectUri(requested)) return false;
  const a = new URL(registered);
  const b = new URL(requested);
  return a.protocol === "http:" && b.protocol === "http:" && LOOPBACK_HOSTS.has(a.hostname) && a.hostname === b.hostname &&
    a.pathname === b.pathname && a.search === b.search;
}

/** A self-declared client name, for logs and the registration response only: one clean line, no markup. */
const cleanName = (value) => cleanText(typeof value === "string" ? value.replace(/[<>]/g, "") : "", 100);

/** The brand for a metadata-document client served from an allowlisted host, else null. */
function brandOf(kind, clientId) {
  if (kind !== "cimd") return null;
  try {
    return BRANDED_CLIENT_HOSTS[new URL(clientId).hostname] ?? null;
  } catch {
    return null;
  }
}

/** Validates client metadata (from a document or a registration request) into the stored form. */
function validateClientMetadata(metadata, { kind, clientId }) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new ClientError("invalid_client_metadata", "client metadata must be a JSON object");
  }
  if (kind === "cimd" && metadata.client_id !== clientId) {
    throw new ClientError("invalid_client", "client metadata document must name its own URL as client_id");
  }
  const redirectUris = metadata.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS ||
      !redirectUris.every(isValidRedirectUri)) {
    throw new ClientError("invalid_redirect_uri", "redirect_uris must list 1-10 https (or loopback http) URLs");
  }
  const grantTypes = metadata.grant_types ?? ["authorization_code"];
  if (!Array.isArray(grantTypes) || !grantTypes.includes("authorization_code") ||
      !grantTypes.every((type) => type === "authorization_code" || type === "refresh_token")) {
    throw new ClientError("invalid_client_metadata", "grant_types may only be authorization_code and refresh_token");
  }
  const responseTypes = metadata.response_types ?? ["code"];
  if (!Array.isArray(responseTypes) || !responseTypes.every((type) => type === "code")) {
    throw new ClientError("invalid_client_metadata", "response_types may only be code");
  }
  // Metadata documents cannot hold a shared secret, so those clients are public (PKCE only).
  const allowed = kind === "cimd" ? ["none"] : ["none", "client_secret_post", "client_secret_basic"];
  const authMethod = metadata.token_endpoint_auth_method ?? (kind === "cimd" ? "none" : "client_secret_basic");
  if (!allowed.includes(authMethod)) {
    throw new ClientError("invalid_client_metadata", `token_endpoint_auth_method must be one of ${allowed.join(", ")}`);
  }
  let clientUri = null;
  if (typeof metadata.client_uri === "string" && metadata.client_uri.length <= MAX_URL_LENGTH) {
    try {
      if (new URL(metadata.client_uri).protocol === "https:") clientUri = metadata.client_uri;
    } catch {
      clientUri = null;
    }
  }
  const brand = brandOf(kind, clientId);
  return {
    kind,
    clientId,
    // What the user sees: the brand for an allowlisted metadata host, otherwise "Unverified app".
    clientName: brand ? brand.name : UNVERIFIED_NAME,
    declaredName: cleanName(metadata.client_name) || null,
    verified: Boolean(brand),
    assistant: brand ? brand.assistant : "other",
    redirectUris,
    grantTypes,
    tokenEndpointAuthMethod: authMethod,
    clientUri,
  };
}

/** Stores a Dynamic Client Registration request. Returns the RFC 7591 response body. */
async function registerClient(db, body, { now }) {
  const clientId = `aot_client_${randomBytes(18).toString("base64url")}`;
  const client = validateClientMetadata(body, { kind: "dcr", clientId });
  let clientSecret = null;
  if (client.tokenEndpointAuthMethod !== "none") clientSecret = `aot_secret_${randomBytes(32).toString("base64url")}`;
  await db.collection(COLLECTIONS.clients).doc(clientDocId(clientId)).set({
    ...client,
    clientSecretHash: clientSecret ? sha256(clientSecret) : null,
    createdAt: new Date(now),
    expiresAt: new Date(now + CLIENT_IDLE_TTL_MS),
  });
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(now / 1000),
    ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
    ...(client.declaredName ? { client_name: client.declaredName } : {}),
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    response_types: ["code"],
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
  };
}

const failureRef = (db, clientId) => db.collection(COLLECTIONS.limits).doc(sha256Hex(`metadata_failed|${clientId}`));

/**
 * Looks up a client by client_id: a registered (DCR) client from Firestore, or a metadata document
 * client, cached for a day. Only `fetch: true` (the authorization endpoint) may fetch a document;
 * the token and revocation endpoints use stored clients only. A failed fetch is remembered for ten
 * minutes, and `limiters` (metadataFetchHost, metadataFetchGlobal) cap fetches. While a document
 * can't be fetched, a cached copy up to a week old keeps working. Throws ClientError("invalid_client").
 */
async function getClient(db, clientId, { now, fetchMetadata = fetchClientMetadata, logger, fetch = false, limiters } = {}) {
  if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > MAX_URL_LENGTH) {
    throw new ClientError("invalid_client", "client_id is missing");
  }
  const ref = db.collection(COLLECTIONS.clients).doc(clientDocId(clientId));
  const cached = await ref.get();
  const stored = cached.exists ? cached.data() : null;
  if (!clientId.startsWith("https://")) {
    if (!stored || stored.clientId !== clientId || stored.kind !== "dcr") throw new ClientError("invalid_client", "unknown client_id");
    return stored;
  }
  if (stored && (stored.clientId !== clientId || stored.kind !== "cimd")) throw new ClientError("invalid_client", "unknown client_id");
  const fetchedAt = toMillis(stored?.fetchedAt);
  if (stored && (!fetch || (fetchedAt !== null && now - fetchedAt < CIMD_FRESH_MS))) return stored;
  if (!fetch) throw new ClientError("invalid_client", "unknown client_id; start connecting again");

  const log = (level, outcome, reason) => logEvent(logger, level, "oauth.client_metadata", { clientId: clientIdForLog(clientId), kind: "cimd", outcome, reason });
  /** A cached copy while the document is unavailable, else the error. */
  const unavailable = (reason, error) => {
    if (stored && fetchedAt !== null && now - fetchedAt < CIMD_STALE_OK_MS) {
      log("warn", "stale_cache", reason);
      return stored;
    }
    log("warn", "rejected", reason);
    throw error instanceof ClientError ? error : new ClientError("invalid_client", reason);
  };
  const failure = await failureRef(db, clientId).get();
  if (failure.exists && toMillis(failure.data().expiresAt) > now) {
    return unavailable("client metadata document failed recently; try again in a few minutes");
  }
  let host = "";
  try {
    host = new URL(clientId).hostname;
  } catch {
    host = "";
  }
  if (limiters && (!limiters.metadataFetchHost(host, now) || !limiters.metadataFetchGlobal("all", now))) {
    return unavailable("too many client metadata fetches; try again later");
  }
  let client;
  try {
    client = validateClientMetadata(await fetchMetadata(clientId), { kind: "cimd", clientId });
  } catch (error) {
    const reason = error instanceof ClientError ? error.message : "client metadata document could not be used";
    await failureRef(db, clientId).set({ expiresAt: new Date(now + METADATA_FAILURE_CACHE_MS) }).catch((writeError) => {
      logEvent(logger, "warn", "oauth.client_metadata", { clientId: clientIdForLog(clientId), outcome: "failure_cache_write_failed", ...errorFields(writeError) });
    });
    return unavailable(reason, error);
  }
  const record = {
    ...client,
    clientSecretHash: null,
    createdAt: stored?.createdAt ?? new Date(now),
    fetchedAt: new Date(now),
    expiresAt: new Date(now + CLIENT_IDLE_TTL_MS),
  };
  await ref.set(record);
  logEvent(logger, "info", "oauth.client_metadata", {
    clientId: clientIdForLog(clientId), client: record.clientName, assistant: record.assistant, kind: "cimd", outcome: stored ? "refreshed" : "registered",
  });
  return record;
}

/** Keeps a client that is still in use from expiring (at most one write a day per client). */
async function touchClient(db, client, now) {
  const expiresAt = toMillis(client.expiresAt);
  if (expiresAt !== null && expiresAt - now > CLIENT_IDLE_TTL_MS - 24 * 60 * 60 * 1000) return;
  await db.collection(COLLECTIONS.clients).doc(clientDocId(client.clientId)).update({ expiresAt: new Date(now + CLIENT_IDLE_TTL_MS) });
}

/** Constant-time client secret check for confidential DCR clients; public clients need none. */
function authenticateClient(client, secret) {
  if (client.tokenEndpointAuthMethod === "none") return true;
  if (typeof secret !== "string" || !client.clientSecretHash) return false;
  const expected = Buffer.from(client.clientSecretHash, "hex");
  const actual = Buffer.from(sha256(secret), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

module.exports = {
  BRANDED_CLIENT_HOSTS,
  CIMD_MAX_BYTES,
  ClientError,
  METADATA_FAILURE_CACHE_MS,
  UNVERIFIED_NAME,
  authenticateClient,
  clientDocId,
  fetchClientMetadata,
  getClient,
  httpsGet,
  isPublicAddress,
  isValidRedirectUri,
  parseClientIdUrl,
  redirectMatches,
  registerClient,
  resolvePublic,
  touchClient,
  validateClientMetadata,
};

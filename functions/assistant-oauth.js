"use strict";

// OAuth 2.1 authorization server for the assistant connector. Firebase Auth (Google sign-in on the
// consent page) identifies the user; this module issues opaque tokens for the MCP endpoint.
//
// - Authorization codes, access tokens and refresh tokens are 256-bit random strings, stored only
//   as SHA-256 hashes. Codes last 10 minutes and work once; access tokens last an hour; refresh
//   tokens rotate on every use. Presenting a used code or refresh token again within 30 seconds
//   is refused (a client retrying a lost response); later, it revokes the whole connection.
// - Clients from unverified hosts never get an error redirect: problems show an error page, so
//   this server can't be used to bounce users to an arbitrary site.
// - A grant (oauthGrants/{grantId}) is one assistant connection. The account's
//   assistant/state document counts them; the last revocation deletes the connector data
//   (docs/ASSISTANT_PROTOCOL.md "Connection lifecycle").

const { createHash, randomBytes, randomUUID } = require("node:crypto");

const {
  COLLECTIONS, deleteCollection, deleteConnectorData, readDevices, refs, toMillis,
} = require("./assistant-data");
const {
  ClientError, authenticateClient, getClient, redirectMatches, touchClient,
} = require("./assistant-oauth-clients");
const { clientIdForLog, errorFields, logEvent } = require("./assistant-log");
const { createInstanceLimiters } = require("./assistant-limits");
const { sendToDevices } = require("./assistant-push");

const PRODUCTION_ORIGIN = "https://alwaysontime.zombit.io";
// Firebase Hosting also serves the site on its default domains. Assistant requests that reach one of
// them are sent to PRODUCTION_ORIGIN instead (movedUrl), so there is one issuer and one MCP URL.
const LEGACY_HOSTS = ["always-on-time-zombit-2026.web.app", "always-on-time-zombit-2026.firebaseapp.com"];
const SCOPES = ["alarms.read", "alarms.write"];
const REQUEST_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const GRANT_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
// A used code or refresh token presented again within this window is most likely a client retrying
// a request whose response it lost: refuse it, but do not revoke the connection.
const REUSE_GRACE_MS = 30 * 1000;
const REFRESH_REUSE_GRACE_MS = REUSE_GRACE_MS;
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

class OAuthError extends Error {
  constructor(error, description, status = 400) {
    super(description);
    this.error = error;
    this.status = status;
  }
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const base64urlSha256 = (text) => createHash("sha256").update(text).digest("base64url");
const newSecret = (prefix) => `${prefix}${randomBytes(32).toString("base64url")}`;
const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;

function urls(origin = PRODUCTION_ORIGIN) {
  return {
    origin,
    issuer: origin,
    mcp: `${origin}/mcp`,
    resourceMetadata: `${origin}/.well-known/oauth-protected-resource/mcp`,
    consent: `${origin}/connect/`,
  };
}

/**
 * The same URL on `origin` when the request came through Hosting on one of `legacyHosts` (Hosting
 * passes the visitor's host in X-Forwarded-Host), otherwise null. Only listed hosts move, so a
 * missing or unexpected header leaves the request alone rather than risking a redirect loop.
 */
function movedUrl(req, origin, legacyHosts = []) {
  if (!legacyHosts.length) return null;
  const header = req.headers?.["x-forwarded-host"];
  const host = String((Array.isArray(header) ? header[0] : header) ?? "").split(",")[0].trim().toLowerCase().replace(/:443$/, "");
  if (!legacyHosts.includes(host)) return null;
  const path = req.originalUrl ?? req.url ?? "/";
  // Appended as text, never resolved: a path like //example.com must stay on this origin.
  return `${origin}${path.startsWith("/") ? path : `/${path}`}`;
}

function protectedResourceMetadata(origin) {
  const u = urls(origin);
  return {
    resource: u.mcp,
    authorization_servers: [u.issuer],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Always On Time",
    resource_documentation: "https://github.com/KtodaZ/always-on-time-cloud/blob/main/docs/ASSISTANT_CONNECTOR.md",
  };
}

function authorizationServerMetadata(origin) {
  const u = urls(origin);
  return {
    issuer: u.issuer,
    authorization_endpoint: `${u.origin}/oauth/authorize`,
    token_endpoint: `${u.origin}/oauth/token`,
    registration_endpoint: `${u.origin}/oauth/register`,
    revocation_endpoint: `${u.origin}/oauth/revoke`,
    scopes_supported: SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: "https://github.com/KtodaZ/always-on-time-cloud/blob/main/docs/ASSISTANT_CONNECTOR.md",
  };
}

/** Unknown scopes are ignored; no scope means both. */
function parseScopes(scope) {
  const requested = typeof scope === "string" ? scope.split(/\s+/).filter((item) => SCOPES.includes(item)) : [];
  return requested.length ? SCOPES.filter((item) => requested.includes(item)) : [...SCOPES];
}

/** The resource indicator, when given, must name this MCP server (a trailing slash is tolerated). */
function checkResource(resource, origin) {
  if (resource === undefined || resource === null || resource === "") return;
  const values = Array.isArray(resource) ? resource : [resource];
  const mcp = urls(origin).mcp;
  if (!values.every((value) => value === mcp || value === `${mcp}/`)) {
    throw new OAuthError("invalid_target", `resource must be ${mcp}`);
  }
}

function withParams(uri, params) {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.append(key, value);
  return url.toString();
}

const hostOf = (uri) => {
  try {
    return new URL(uri).host;
  } catch {
    return "";
  }
};

function createOAuth(deps) {
  const { db, now = Date.now, verifyIdToken, fetchMetadata, messaging, logger, usage = async () => {} } = deps;
  const origin = deps.origin ?? PRODUCTION_ORIGIN;
  const u = urls(origin);
  const collection = (name) => db.collection(COLLECTIONS[name]);
  const limiters = deps.limiters ?? createInstanceLimiters();
  const log = (level, event, fields) => logEvent(logger, level, event, fields);
  const touch = (client, time) => touchClient(db, client, time).catch((error) => {
    log("warn", "oauth.client_touch_failed", { clientId: clientIdForLog(client.clientId), ...errorFields(error) });
  });
  /** A client by client_id; only the authorization endpoint (`fetch`) may fetch a metadata document. */
  const lookupClient = async (clientId, { fetch = false } = {}) => {
    try {
      return await getClient(db, clientId, { now: now(), fetchMetadata, logger, fetch, limiters });
    } catch (error) {
      if (error instanceof ClientError) throw new OAuthError("invalid_client", error.message, 401);
      throw error;
    }
  };

  // ---- Authorization ------------------------------------------------------------------------

  /**
   * Handles /oauth/authorize. Returns {redirect} to the consent page or back to the client with an
   * error, or {page} for problems that must not redirect (unknown client or redirect URI).
   */
  async function authorize(query) {
    const value = (name) => (typeof query[name] === "string" ? query[name] : undefined);
    let client;
    try {
      client = await lookupClient(value("client_id"), { fetch: true });
    } catch (error) {
      log("info", "oauth.authorize", { clientId: clientIdForLog(value("client_id")), outcome: "unknown_client" });
      return { page: { status: 400, message: "This assistant could not be identified. Start connecting again from your assistant." } };
    }
    const requested = value("redirect_uri");
    let redirectUri;
    if (requested) redirectUri = client.redirectUris.some((registered) => redirectMatches(registered, requested)) ? requested : null;
    else redirectUri = client.redirectUris.length === 1 ? client.redirectUris[0] : null;
    if (!redirectUri) {
      log("info", "oauth.authorize", { clientId: clientIdForLog(client.clientId), outcome: "unregistered_redirect" });
      return { page: { status: 400, message: "This sign-in link has an unregistered return address. Start connecting again from your assistant." } };
    }

    const state = value("state");
    const fail = (error, description) => {
      log("info", "oauth.authorize", { clientId: clientIdForLog(client.clientId), outcome: error });
      // Only verified assistants get errors at their redirect URI; anyone can register an unverified one.
      if (!client.verified) return { page: { status: 400, message: `This connection request isn’t valid (${description}). Start connecting again from your assistant.` } };
      return { redirect: withParams(redirectUri, { error, error_description: description, state, iss: u.issuer }) };
    };
    if (value("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code");
    const challenge = value("code_challenge");
    if (!challenge || !PKCE_VALUE.test(challenge) || value("code_challenge_method") !== "S256") {
      return fail("invalid_request", "PKCE with code_challenge_method S256 is required");
    }
    if (state && state.length > 4096) return fail("invalid_request", "state is too long");
    try {
      checkResource(query.resource, origin);
    } catch (error) {
      return fail(error.error, error.message);
    }
    const requestId = newSecret("");
    const time = now();
    await collection("requests").doc(sha256(requestId)).set({
      clientId: client.clientId,
      redirectUri,
      redirectUriProvided: Boolean(requested),
      verified: client.verified === true,
      state: state ?? null,
      codeChallenge: challenge,
      scopes: parseScopes(value("scope")),
      createdAt: new Date(time),
      expiresAt: new Date(time + REQUEST_TTL_MS),
    });
    log("info", "oauth.authorize", { clientId: clientIdForLog(client.clientId), client: client.clientName, outcome: "consent" });
    return { redirect: `${u.consent}?request=${encodeURIComponent(requestId)}` };
  }

  async function pendingRequest(requestId) {
    if (typeof requestId !== "string" || requestId.length < 20 || requestId.length > 100) return null;
    const doc = await collection("requests").doc(sha256(requestId)).get();
    if (!doc.exists || toMillis(doc.data().expiresAt) <= now()) return null;
    return { ref: doc.ref, ...doc.data() };
  }

  /** Verifies a Firebase ID token from the consent page: a Google-linked account. */
  async function signedInUser(idToken) {
    if (typeof idToken !== "string" || idToken.length === 0) throw new OAuthError("login_required", "Sign in with Google first.", 401);
    let decoded;
    try {
      decoded = await verifyIdToken(idToken);
    } catch {
      throw new OAuthError("login_required", "Your sign-in expired. Sign in again.", 401);
    }
    if (!decoded?.firebase?.identities?.["google.com"]?.length) throw new OAuthError("login_required", "Sign in with Google first.", 401);
    const accountDoc = await refs.account(db, decoded.uid).get();
    return { uid: decoded.uid, email: decoded.email ?? null, accountReady: accountDoc.exists && accountDoc.data().active === true };
  }

  /** What the consent page shows: who is asking and where the user returns, plus account status. */
  async function consentInfo({ request: requestId, idToken }) {
    const pending = await pendingRequest(requestId);
    if (!pending) throw new OAuthError("expired", "This connection request expired. Start connecting again from your assistant.", 404);
    const client = await lookupClient(pending.clientId);
    const info = {
      clientName: client.clientName,
      verified: client.verified === true,
      clientHost: hostOf(pending.redirectUri),
      scopes: pending.scopes,
    };
    if (!idToken) return info;
    const user = await signedInUser(idToken);
    return { ...info, email: user.email, account: user.accountReady ? "ready" : "not_ready" };
  }

  /**
   * Approve or cancel from the consent page. Returns {redirect} for the browser, or for a
   * cancelled unverified client {cancelled: true} (the page says so instead of redirecting).
   */
  async function decide({ request: requestId, idToken, decision }) {
    if (decision !== "approve" && decision !== "deny") throw new OAuthError("invalid_request", "decision must be approve or deny");
    if (decision === "deny") {
      const pending = await pendingRequest(requestId);
      if (!pending) throw new OAuthError("expired", "This connection request expired.", 404);
      await pending.ref.delete();
      log("info", "oauth.consent", { clientId: clientIdForLog(pending.clientId), outcome: "denied" });
      if (!pending.verified) return { cancelled: true };
      return { redirect: withParams(pending.redirectUri, { error: "access_denied", error_description: "The user cancelled.", state: pending.state, iss: u.issuer }) };
    }
    const user = await signedInUser(idToken);
    if (!user.accountReady) {
      log("info", "oauth.consent", { uid: user.uid, outcome: "account_not_ready" });
      throw new OAuthError("account_not_ready", "Install Always On Time and sign in with this Google account in the app first.", 409);
    }
    const code = newSecret("aot_code_");
    const time = now();
    const pending = await db.runTransaction(async (transaction) => {
      const ref = collection("requests").doc(sha256(String(requestId)));
      const doc = await transaction.get(ref);
      if (!doc.exists || toMillis(doc.data().expiresAt) <= time) return null;
      const data = doc.data();
      transaction.delete(ref);
      transaction.set(collection("codes").doc(sha256(code)), {
        uid: user.uid,
        clientId: data.clientId,
        redirectUri: data.redirectUri,
        redirectUriProvided: data.redirectUriProvided,
        codeChallenge: data.codeChallenge,
        scopes: data.scopes,
        createdAt: new Date(time),
        expiresAt: new Date(time + CODE_TTL_MS),
        usedAt: null,
        grantId: null,
      });
      return data;
    });
    if (!pending) {
      log("info", "oauth.consent", { uid: user.uid, outcome: "expired" });
      throw new OAuthError("expired", "This connection request expired. Start connecting again from your assistant.", 404);
    }
    log("info", "oauth.consent", { uid: user.uid, clientId: clientIdForLog(pending.clientId), scopes: pending.scopes, outcome: "approved" });
    return { redirect: withParams(pending.redirectUri, { code, state: pending.state, iss: u.issuer }) };
  }

  // ---- Tokens -------------------------------------------------------------------------------

  function issueTokens(transaction, grant, time) {
    const accessToken = newSecret("aot_at_");
    const refreshToken = newSecret("aot_rt_");
    const common = { grantId: grant.grantId, uid: grant.uid, clientId: grant.clientId, createdAt: new Date(time) };
    transaction.set(collection("tokens").doc(sha256(accessToken)), { ...common, kind: "access", expiresAt: new Date(time + ACCESS_TTL_MS) });
    transaction.set(collection("tokens").doc(sha256(refreshToken)), {
      ...common, kind: "refresh", rotatedAt: null, expiresAt: new Date(time + REFRESH_TTL_MS),
    });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_MS / 1000,
      refresh_token: refreshToken,
      scope: grant.scopes.join(" "),
    };
  }

  /** Authenticates the client at the token or revocation endpoint (stored clients only, never a fetch). */
  async function tokenClient(body, basic) {
    const clientId = basic?.clientId ?? body.client_id;
    const client = await lookupClient(clientId);
    if (basic?.clientId && body.client_id && body.client_id !== basic.clientId) throw new OAuthError("invalid_client", "client_id mismatch", 401);
    if (!authenticateClient(client, basic?.clientSecret ?? body.client_secret)) throw new OAuthError("invalid_client", "client authentication failed", 401);
    return client;
  }

  async function exchangeCode(body, client) {
    const code = body.code;
    if (typeof code !== "string" || !code.startsWith("aot_code_")) throw new OAuthError("invalid_grant", "invalid authorization code");
    const verifier = body.code_verifier;
    if (typeof verifier !== "string" || !PKCE_VALUE.test(verifier)) throw new OAuthError("invalid_grant", "code_verifier is required");
    checkResource(body.resource, origin);
    const time = now();
    const grantId = randomUUID();
    const outcome = await db.runTransaction(async (transaction) => {
      const codeRef = collection("codes").doc(sha256(code));
      const doc = await transaction.get(codeRef);
      if (!doc.exists) return { error: "invalid authorization code" };
      const data = doc.data();
      const usedAt = toMillis(data.usedAt);
      if (usedAt !== null) {
        return time - usedAt < REUSE_GRACE_MS
          ? { error: "authorization code was already used" }
          : { error: "authorization code was already used; the connection was revoked", revoke: data.grantId };
      }
      if (toMillis(data.expiresAt) <= time) return { error: "authorization code expired" };
      if (data.clientId !== client.clientId) return { error: "authorization code was issued to another client" };
      if (data.redirectUriProvided || body.redirect_uri !== undefined) {
        if (body.redirect_uri !== data.redirectUri) return { error: "redirect_uri does not match" };
      }
      if (base64urlSha256(verifier) !== data.codeChallenge) return { error: "PKCE verification failed" };
      // A reconnect of the same assistant replaces its previous connection.
      const existing = await transaction.get(collection("grants").where("uid", "==", data.uid));
      const replaced = existing.docs.filter((grantDoc) => grantDoc.data().clientId === client.clientId).map((grantDoc) => grantDoc.id);
      const connections = existing.size - replaced.length + 1;
      const stateRef = refs.state(db, data.uid);
      const grant = {
        grantId,
        uid: data.uid,
        clientId: client.clientId,
        clientName: client.clientName,
        assistant: client.assistant ?? "other",
        verified: client.verified === true,
        // Where the connection's codes went: how the user tells an unverified app apart.
        clientHost: hostOf(data.redirectUri),
        scopes: data.scopes,
        createdAt: new Date(time),
        lastUsedAt: new Date(time),
        setupConfirmedAt: null,
      };
      transaction.update(codeRef, { usedAt: new Date(time), grantId });
      for (const id of replaced) transaction.delete(collection("grants").doc(id));
      transaction.set(collection("grants").doc(grantId), grant);
      transaction.set(stateRef, { connected: true, connections, updatedAt: new Date(time) });
      return { grant, tokens: issueTokens(transaction, grant, time), replaced, connectionsChanged: replaced.length === 0 };
    });
    if (outcome.error) {
      log("warn", "oauth.code_exchange", {
        clientId: clientIdForLog(client.clientId), outcome: "rejected", reason: outcome.error, revokedGrantId: outcome.revoke,
      });
      if (outcome.revoke) await revokeGrant(outcome.revoke, { reason: "code_reuse" });
      throw new OAuthError("invalid_grant", outcome.error);
    }
    log("info", "oauth.code_exchange", {
      uid: outcome.grant.uid,
      grantId: outcome.grant.grantId,
      clientId: clientIdForLog(client.clientId),
      client: client.clientName,
      assistant: outcome.grant.assistant,
      scopes: outcome.grant.scopes,
      replacedGrantIds: outcome.replaced,
      outcome: "ok",
    });
    for (const id of outcome.replaced) await deleteTokens(id);
    await touch(client, time);
    await usage({ [`connectionsNew.${outcome.grant.assistant}`]: 1 });
    if (outcome.connectionsChanged) await notifyState(outcome.grant.uid);
    return outcome.tokens;
  }

  async function refresh(body, client) {
    const token = body.refresh_token;
    if (typeof token !== "string" || !token.startsWith("aot_rt_")) throw new OAuthError("invalid_grant", "invalid refresh token");
    const time = now();
    const outcome = await db.runTransaction(async (transaction) => {
      const tokenRef = collection("tokens").doc(sha256(token));
      const doc = await transaction.get(tokenRef);
      if (!doc.exists || doc.data().kind !== "refresh") return { error: "invalid refresh token" };
      const data = doc.data();
      if (data.clientId !== client.clientId) return { error: "refresh token was issued to another client" };
      if (toMillis(data.expiresAt) <= time) return { error: "refresh token expired" };
      const rotatedAt = toMillis(data.rotatedAt);
      if (rotatedAt !== null) {
        return time - rotatedAt < REFRESH_REUSE_GRACE_MS
          ? { error: "refresh token was already used" }
          : { error: "refresh token was already used; the connection was revoked", revoke: data.grantId };
      }
      const grantRef = collection("grants").doc(data.grantId);
      const grantDoc = await transaction.get(grantRef);
      if (!grantDoc.exists) return { error: "connection was revoked" };
      const grant = grantDoc.data();
      transaction.update(tokenRef, { rotatedAt: new Date(time) });
      transaction.update(grantRef, { lastUsedAt: new Date(time) });
      return { grant, tokens: issueTokens(transaction, grant, time) };
    });
    if (outcome.error) {
      log("warn", "oauth.refresh", {
        clientId: clientIdForLog(client.clientId), outcome: "rejected", reason: outcome.error, revokedGrantId: outcome.revoke,
      });
      if (outcome.revoke) await revokeGrant(outcome.revoke, { reason: "refresh_reuse" });
      throw new OAuthError("invalid_grant", outcome.error);
    }
    log("info", "oauth.refresh", { uid: outcome.grant.uid, grantId: outcome.grant.grantId, client: outcome.grant.clientName, outcome: "ok" });
    await touch(client, time);
    return outcome.tokens;
  }

  /** /oauth/token. `basic` is {clientId, clientSecret} from an Authorization: Basic header. */
  async function token(body, basic) {
    const client = await tokenClient(body, basic);
    if (body.grant_type === "authorization_code") return exchangeCode(body, client);
    if (body.grant_type === "refresh_token") return refresh(body, client);
    throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  }

  /** /oauth/revoke (RFC 7009): always succeeds; revoking a refresh token ends the connection. */
  async function revoke(body, basic) {
    const client = await tokenClient(body, basic);
    const value = body.token;
    if (typeof value !== "string" || value.length > 200) {
      log("info", "oauth.revoke", { clientId: clientIdForLog(client.clientId), outcome: "ignored", reason: "malformed" });
      return;
    }
    const doc = await collection("tokens").doc(sha256(value)).get();
    if (!doc.exists || doc.data().clientId !== client.clientId) {
      log("info", "oauth.revoke", { clientId: clientIdForLog(client.clientId), outcome: "ignored", reason: "unknown_token" });
      return;
    }
    const { kind, grantId, uid } = doc.data();
    log("info", "oauth.revoke", { uid, grantId, clientId: clientIdForLog(client.clientId), kind, outcome: "ok" });
    if (kind === "refresh") await revokeGrant(grantId, { reason: "client" });
    else await doc.ref.delete();
  }

  // ---- Connections --------------------------------------------------------------------------

  async function deleteTokens(grantId) {
    await deleteCollection(db, collection("tokens").where("grantId", "==", grantId));
  }

  /** Tells the account's phones to re-read assistant/state. Never fails the caller. */
  async function notifyState(uid, devices = null) {
    try {
      await sendToDevices({ db, messaging, logger }, uid, "state", {}, devices);
    } catch (error) {
      log("warn", "push.state_failed", { uid, errorName: error?.name, errorCode: error?.code });
    }
  }

  /**
   * Revokes one connection: deletes the grant and its tokens and updates assistant/state. The last
   * connection's revocation also deletes the account's snapshots, devices and activity.
   */
  async function revokeGrant(grantId, { reason = "user", uid: expectedUid } = {}) {
    if (typeof grantId !== "string" || grantId.length === 0 || grantId.length > 100) return false;
    const time = now();
    const outcome = await db.runTransaction(async (transaction) => {
      const grantRef = collection("grants").doc(grantId);
      const doc = await transaction.get(grantRef);
      if (!doc.exists) return null;
      const grant = doc.data();
      if (expectedUid !== undefined && grant.uid !== expectedUid) return null;
      const all = await transaction.get(collection("grants").where("uid", "==", grant.uid));
      const remaining = all.docs.filter((grantDoc) => grantDoc.id !== grantId).length;
      transaction.delete(grantRef);
      transaction.set(refs.state(db, grant.uid), { connected: remaining > 0, connections: remaining, updatedAt: new Date(time) });
      return { grant, remaining };
    });
    if (!outcome) return false;
    await deleteTokens(grantId);
    const devices = await readDevices(db, outcome.grant.uid);
    await notifyState(outcome.grant.uid, devices);
    // Another assistant may connect while this cleans up; its data is then left alone.
    if (outcome.remaining === 0) await deleteConnectorData(db, outcome.grant.uid, { onlyIfDisconnected: true });
    await usage({ [`disconnects.${outcome.grant.assistant ?? "other"}`]: 1 });
    log("info", "connection.revoked", {
      uid: outcome.grant.uid, grantId, client: outcome.grant.clientName, reason, remaining: outcome.remaining,
    });
    return true;
  }

  async function listConnections(uid) {
    const page = await collection("grants").where("uid", "==", uid).get();
    return page.docs.map((doc) => {
      const grant = doc.data();
      return {
        grantId: doc.id,
        clientName: grant.clientName,
        assistant: grant.assistant,
        verified: grant.verified === true,
        clientHost: grant.clientHost ?? null,
        scopes: grant.scopes,
        createdAt: toMillis(grant.createdAt),
        lastUsedAt: toMillis(grant.lastUsedAt),
        setupConfirmedAt: toMillis(grant.setupConfirmedAt),
      };
    }).sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
  }

  /** Revokes connections nobody has used for 90 days (their refresh tokens have expired too). */
  async function pruneIdleGrants() {
    const cutoff = new Date(now() - GRANT_IDLE_MS);
    let revoked = 0;
    for (;;) {
      const page = await collection("grants").where("lastUsedAt", "<", cutoff).limit(100).get();
      if (page.empty) return revoked;
      for (const doc of page.docs) if (await revokeGrant(doc.id, { reason: "idle" })) revoked += 1;
    }
  }

  return {
    authorize,
    consentInfo,
    decide,
    listConnections,
    notifyState,
    pruneIdleGrants,
    revoke,
    revokeGrant,
    token,
    urls: u,
  };
}

/**
 * Resolves a bearer token for the MCP endpoint: {uid, grantId, clientId, clientName, assistant,
 * scopes, ...} for a live access token whose connection still exists, otherwise null.
 * `onReject(reason)` hears why a token was refused (for the debugging log; never the token).
 */
async function verifyAccessToken(db, token, { now = Date.now(), onReject = () => {} } = {}) {
  const reject = (reason) => {
    onReject(reason);
    return null;
  };
  if (typeof token !== "string" || !token.startsWith("aot_at_") || token.length > 200) return reject("malformed");
  const doc = await db.collection(COLLECTIONS.tokens).doc(sha256(token)).get();
  if (!doc.exists) return reject("unknown");
  const data = doc.data();
  if (data.kind !== "access") return reject("not_access_token");
  if (toMillis(data.expiresAt) <= now) return reject("expired");
  const grantDoc = await db.collection(COLLECTIONS.grants).doc(data.grantId).get();
  if (!grantDoc.exists || grantDoc.data().uid !== data.uid) return reject("connection_revoked");
  const grant = grantDoc.data();
  return {
    uid: data.uid,
    grantId: data.grantId,
    clientId: grant.clientId,
    clientName: grant.clientName,
    assistant: grant.assistant ?? "other",
    scopes: grant.scopes ?? [],
    setupConfirmedAt: toMillis(grant.setupConfirmedAt),
    lastUsedAt: toMillis(grant.lastUsedAt),
    lastActiveDay: grant.lastActiveDay ?? null,
    lastActiveWeek: grant.lastActiveWeek ?? null,
  };
}

/** Deletes every connection of an account and its tokens (account deletion); no pushes. */
async function deleteAllGrants(db, uid) {
  const page = await db.collection(COLLECTIONS.grants).where("uid", "==", uid).get();
  for (const doc of page.docs) {
    await deleteCollection(db, db.collection(COLLECTIONS.tokens).where("grantId", "==", doc.id));
    await doc.ref.delete();
  }
  return page.size;
}

module.exports = {
  ACCESS_TTL_MS,
  CODE_TTL_MS,
  LAST_USED_RESOLUTION_MS,
  LEGACY_HOSTS,
  OAuthError,
  PRODUCTION_ORIGIN,
  REFRESH_REUSE_GRACE_MS,
  REFRESH_TTL_MS,
  REUSE_GRACE_MS,
  SCOPES,
  authorizationServerMetadata,
  createOAuth,
  deleteAllGrants,
  movedUrl,
  parseScopes,
  protectedResourceMetadata,
  urls,
  verifyAccessToken,
};

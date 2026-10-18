"use strict";

// HTTP routes for the assistant connector's OAuth server and discovery documents. Firebase Hosting
// rewrites /oauth/** and /.well-known/oauth-* on the public origin to this handler. The same paths on
// a legacy host (`legacyHosts`) get a 308 to the public origin, which keeps the method and body.

const { createHash } = require("node:crypto");

const { OAuthError, authorizationServerMetadata, movedUrl, protectedResourceMetadata } = require("./assistant-oauth");
const { ClientError, registerClient, validateClientMetadata } = require("./assistant-oauth-clients");
const { COLLECTIONS } = require("./assistant-data");
const {
  LIMITS, admitDirect, clientKeys, consume, countFailure, createInstanceLimiters, failuresExceeded,
} = require("./assistant-limits");
const { errorFields, logEvent } = require("./assistant-log");

const MAX_BODY_CHARS = 16 * 1024;

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  for (const [name, value] of Object.entries({ "Cache-Control": "no-store", ...headers })) res.setHeader(name, value);
  if (body === undefined) res.end();
  else if (typeof body === "string") res.end(body);
  else {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Access-Control-Max-Age": "600",
};

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function errorPage(res, status, message) {
  send(res, status, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Connect an assistant · Always On Time</title><link rel="stylesheet" href="/account.css">` +
    `<main><h1>Couldn’t connect</h1><p>${escapeHtml(message)}</p></main></html>`,
  { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" });
}

function pathOf(req) {
  if (typeof req.path === "string") return req.path;
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

function queryOf(req) {
  if (req.query && typeof req.query === "object") return req.query;
  return Object.fromEntries(new URL(req.url ?? "/", "http://localhost").searchParams);
}

/** The parsed body (Firebase parses JSON and form bodies); only small flat objects are accepted. */
function bodyOf(req) {
  let body = req.body;
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    const text = body.toString();
    if (text.length > MAX_BODY_CHARS) throw new OAuthError("invalid_request", "request body is too large", 413);
    const type = String(req.headers["content-type"] ?? "");
    body = type.includes("application/json") ? JSON.parse(text || "{}") : Object.fromEntries(new URLSearchParams(text));
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  if (JSON.stringify(body).length > MAX_BODY_CHARS) throw new OAuthError("invalid_request", "request body is too large", 413);
  return body;
}

/** {clientId, clientSecret} from an Authorization: Basic header (RFC 6749 section 2.3.1 encoding). */
function basicAuth(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  const decode = (value) => {
    try {
      return decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
      return value;
    }
  };
  return { clientId: decode(decoded.slice(0, separator)), clientSecret: decode(decoded.slice(separator + 1)) };
}

const GRANT_VALUE = { authorization_code: /^aot_code_[A-Za-z0-9_-]{43}$/, refresh_token: /^aot_rt_[A-Za-z0-9_-]{43}$/ };
const REQUEST_ID = /^[A-Za-z0-9_-]{20,100}$/;
const MAX_CLIENT_ID_CHARS = 2048;
const isClientId = (value) => typeof value === "string" && value.length > 0 && value.length <= MAX_CLIENT_ID_CHARS;

/**
 * What a token request presents, from checks that cost nothing: {clientId, type, id}, where id is
 * the document ID of the code or refresh token (its SHA-256, as assistant-oauth.js stores it; they
 * are 256-bit random values, so a fast hash is the right one). Null for a request that can't succeed.
 */
function presentedGrant(body, basic) {
  const type = body.grant_type;
  const clientId = basic?.clientId ?? body.client_id;
  const value = type === "authorization_code" ? body.code : body.refresh_token;
  if (!Object.hasOwn(GRANT_VALUE, type) || !isClientId(clientId) || typeof value !== "string" || !GRANT_VALUE[type].test(value)) return null;
  return { clientId, type, id: createHash("sha256").update(value).digest("hex") };
}

/** The OAuth error for a token request presentedGrant refused. */
function presentedGrantError(body, basic) {
  if (!Object.hasOwn(GRANT_VALUE, body.grant_type)) {
    return new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  }
  if (!isClientId(basic?.clientId ?? body.client_id)) return new OAuthError("invalid_client", "client_id is missing", 401);
  return new OAuthError("invalid_grant", body.grant_type === "authorization_code" ? "invalid authorization code" : "invalid refresh token");
}

function createOAuthHandler({
  oauth, db, now = Date.now, logger, usage = async () => {}, limiters = createInstanceLimiters(), legacyHosts = [],
}) {
  const origin = oauth.urls.origin;
  const hosts = [new URL(origin).host, ...legacyHosts];
  const consentUrl = oauth.urls.consent;
  // Refused requests are counted in memory and written with the next usage update, so a refusal
  // never costs a database write.
  const deferUsage = (counts) => usage.defer?.(counts);
  const caller = (req) => clientKeys(req, { hosts });
  const refuse = (route, extra = {}) => {
    deferUsage({ rateLimited: 1 });
    logEvent(logger, "warn", "oauth.error", { path: route, status: 429, errorCode: "too_many_requests", ...extra });
  };
  const tooMany = (res, route) => {
    refuse(route);
    return send(res, 429, { error: "too_many_requests", error_description: "Too many attempts. Wait a few minutes and try again." }, { ...CORS, "Retry-After": "600" });
  };
  /**
   * For the consent steps, which run in the user's browser: a direct call within its budgets, the
   * caller's Firestore limit `name` (keyed as clientKeys describes), and the failure budgets.
   */
  const browserLimited = async (from, name, failures, time) => {
    if (!admitDirect(limiters, from, time)) return true;
    if (!(await consume(db, `${name}|${from.client}`, LIMITS[name], time))) return true;
    return failuresExceeded(limiters, failures, from, time);
  };
  /** Runs `work`; an OAuthError counts against the caller's `failures` budgets. */
  const counting = async (failures, from, work) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof OAuthError) countFailure(limiters, failures, from, now());
      throw error;
    }
  };
  /** True when the presented code or refresh token exists, issued to this client (one read). */
  const grantExists = async (grant) => {
    const collection = grant.type === "authorization_code" ? COLLECTIONS.codes : COLLECTIONS.tokens;
    const doc = await db.collection(collection).doc(grant.id).get();
    if (!doc.exists) return false;
    const data = doc.data();
    if (grant.type === "refresh_token" && data.kind !== "refresh") return false;
    return data.clientId === grant.clientId;
  };

  const routes = {
    "GET /.well-known/oauth-protected-resource": (req, res) => send(res, 200, protectedResourceMetadata(origin), CORS),
    "GET /.well-known/oauth-protected-resource/mcp": (req, res) => send(res, 200, protectedResourceMetadata(origin), CORS),
    "GET /.well-known/oauth-authorization-server": (req, res) => send(res, 200, authorizationServerMetadata(origin), CORS),

    "POST /oauth/register": async (req, res) => {
      const from = caller(req);
      const time = now();
      const refused = () => {
        refuse("/oauth/register");
        return send(res, 429, { error: "too_many_requests", error_description: "Too many registrations; try again later." }, CORS);
      };
      if (!admitDirect(limiters, from, time) || limiters.registerFailures.exceeded(from.client, time)) return refused();
      const body = bodyOf(req);
      // Only valid registrations count against the registration limits.
      try {
        validateClientMetadata(body, { kind: "dcr", clientId: "aot_client_check" });
      } catch (error) {
        if (!(error instanceof ClientError)) throw error;
        limiters.registerFailures(from.client, time);
        logEvent(logger, "info", "oauth.register", { kind: "dcr", outcome: "rejected", errorCode: error.error, reason: error.message });
        return send(res, 400, { error: error.error, error_description: error.message }, CORS);
      }
      if (!(await consume(db, `register|${from.client}`, LIMITS.register, time)) ||
          !(await consume(db, `registerGlobal|${from.scope}`, LIMITS.registerGlobal, time))) {
        logEvent(logger, "warn", "oauth.register", { kind: "dcr", outcome: "rate_limited" });
        return refused();
      }
      try {
        const registered = await registerClient(db, body, { now: time });
        logEvent(logger, "info", "oauth.register", {
          kind: "dcr", clientId: registered.client_id, client: registered.client_name, outcome: "ok",
        });
        return send(res, 201, registered, CORS);
      } catch (error) {
        if (error instanceof ClientError) {
          logEvent(logger, "info", "oauth.register", { kind: "dcr", outcome: "rejected", errorCode: error.error, reason: error.message });
          return send(res, 400, { error: error.error, error_description: error.message }, CORS);
        }
        throw error;
      }
    },

    "GET /oauth/authorize": async (req, res) => {
      const from = caller(req);
      const time = now();
      const query = queryOf(req);
      if (!isClientId(query.client_id) || (query.redirect_uri !== undefined && (typeof query.redirect_uri !== "string" || query.redirect_uri.length > MAX_CLIENT_ID_CHARS))) {
        if (!admitDirect(limiters, from, time)) return errorPage(res, 429, "Too many attempts. Wait a few minutes and try again.");
        countFailure(limiters, "authorize", from, time);
        return errorPage(res, 400, "This assistant could not be identified. Start connecting again from your assistant.");
      }
      if (await browserLimited(from, "authorize", "authorize", time)) {
        refuse("/oauth/authorize");
        return errorPage(res, 429, "Too many attempts. Wait a few minutes and try again.");
      }
      const result = await oauth.authorize(query);
      if (result.page || !result.redirect.startsWith(`${consentUrl}?`)) countFailure(limiters, "authorize", from, now());
      if (result.page) return errorPage(res, result.page.status, result.page.message);
      return send(res, 302, undefined, { Location: result.redirect });
    },

    "POST /oauth/consent": async (req, res) => {
      const from = caller(req);
      const time = now();
      const body = bodyOf(req);
      if (typeof body.request !== "string" || !REQUEST_ID.test(body.request) || (body.idToken != null && typeof body.idToken !== "string")) {
        if (!admitDirect(limiters, from, time)) return tooMany(res, "/oauth/consent");
        countFailure(limiters, "consent", from, time);
        throw new OAuthError("expired", "This connection request expired. Start connecting again from your assistant.", 404);
      }
      if (await browserLimited(from, "consent", "consent", time)) return tooMany(res, "/oauth/consent");
      return send(res, 200, await counting("consent", from, () => oauth.consentInfo(body)));
    },

    "POST /oauth/approve": async (req, res) => {
      const from = caller(req);
      const time = now();
      const body = bodyOf(req);
      if (typeof body.request !== "string" || !REQUEST_ID.test(body.request)) {
        if (!admitDirect(limiters, from, time)) return tooMany(res, "/oauth/approve");
        countFailure(limiters, "consent", from, time);
        throw new OAuthError("expired", "This connection request expired. Start connecting again from your assistant.", 404);
      }
      if (await browserLimited(from, "approve", "consent", time)) return tooMany(res, "/oauth/approve");
      return send(res, 200, await counting("consent", from, () => oauth.decide(body)));
    },

    /**
     * Limited per presented grant (client_id, grant type and the code or refresh token), not per
     * network: assistants call from shared addresses. Failed requests count against the caller's
     * and the overall failure budgets; once those are used up, a request is still served if its
     * code or refresh token exists, so a valid refresh is never refused because of them.
     */
    "POST /oauth/token": async (req, res) => {
      const from = caller(req);
      const time = now();
      if (!admitDirect(limiters, from, time)) return tooMany(res, "/oauth/token");
      const body = bodyOf(req);
      const basic = basicAuth(req);
      const grant = presentedGrant(body, basic);
      if (!grant) {
        countFailure(limiters, "token", from, time);
        throw presentedGrantError(body, basic);
      }
      const grantKey = createHash("sha256").update(`${grant.clientId}|${grant.type}|${grant.id}`).digest("hex");
      if (!limiters.tokenGrant(grantKey, time)) return tooMany(res, "/oauth/token");
      if (failuresExceeded(limiters, "token", from, time) && !(await grantExists(grant))) return tooMany(res, "/oauth/token");
      const tokens = await counting("token", from, () => oauth.token(body, basic));
      return send(res, 200, tokens, { ...CORS, Pragma: "no-cache" });
    },

    "POST /oauth/revoke": async (req, res) => {
      const from = caller(req);
      const time = now();
      // Not refused for other callers' failures: a disconnect must reach the server.
      if (!admitDirect(limiters, from, time) || !limiters.revoke(from.client, time)) return tooMany(res, "/oauth/revoke");
      const body = bodyOf(req);
      const basic = basicAuth(req);
      if (!isClientId(basic?.clientId ?? body.client_id)) {
        countFailure(limiters, "token", from, time);
        throw new OAuthError("invalid_client", "client_id is missing", 401);
      }
      await counting("token", from, () => oauth.revoke(body, basic));
      return send(res, 200, {}, CORS);
    },
  };

  return async (req, res) => {
    const path = pathOf(req).replace(/\/+$/, "") || "/";
    // Preflights are answered here too, so a browser client can then follow the redirect.
    if (req.method === "OPTIONS") return send(res, 204, undefined, CORS);
    const moved = movedUrl(req, origin, legacyHosts);
    if (moved) {
      logEvent(logger, "info", "host.moved", { path, status: 308 });
      return send(res, 308, undefined, { ...CORS, Location: moved });
    }
    const route = routes[`${req.method} ${path}`];
    if (!route) {
      const known = Object.keys(routes).some((key) => key.endsWith(` ${path}`));
      return send(res, known ? 405 : 404, { error: known ? "method_not_allowed" : "not_found" }, CORS);
    }
    try {
      await route(req, res);
    } catch (error) {
      if (error instanceof OAuthError) {
        // Error codes and their fixed descriptions only; never the request's tokens or codes.
        logEvent(logger, "info", "oauth.error", { path, status: error.status, errorCode: error.error, reason: error.message });
        const headers = { ...CORS };
        if (error.status === 401 && error.error === "invalid_client" && req.headers.authorization?.startsWith("Basic ")) {
          headers["WWW-Authenticate"] = "Basic realm=\"Always On Time\"";
        }
        return send(res, error.status, { error: error.error, error_description: error.message }, headers);
      }
      if (error instanceof SyntaxError) return send(res, 400, { error: "invalid_request", error_description: "malformed body" }, CORS);
      logEvent(logger, "error", "oauth.request_failed", { path, ...errorFields(error) });
      return send(res, 500, { error: "server_error" }, CORS);
    }
  };
}

module.exports = { basicAuth, createOAuthHandler, presentedGrant, send };

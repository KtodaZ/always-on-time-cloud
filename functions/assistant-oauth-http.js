"use strict";

// HTTP routes for the assistant connector's OAuth server and discovery documents. Firebase Hosting
// rewrites /oauth/** and /.well-known/oauth-* on the public origin to this handler.

const { OAuthError, authorizationServerMetadata, protectedResourceMetadata } = require("./assistant-oauth");
const { ClientError, registerClient } = require("./assistant-oauth-clients");
const { LIMITS, clientIp, consume } = require("./assistant-limits");

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

function createOAuthHandler({ oauth, db, now = Date.now, logger, usage = async () => {} }) {
  const origin = oauth.urls.origin;
  const limited = async (name, key) => !(await consume(db, `${name}|${key}`, LIMITS[name], now()));

  const routes = {
    "GET /.well-known/oauth-protected-resource": (req, res) => send(res, 200, protectedResourceMetadata(origin), CORS),
    "GET /.well-known/oauth-protected-resource/mcp": (req, res) => send(res, 200, protectedResourceMetadata(origin), CORS),
    "GET /.well-known/oauth-authorization-server": (req, res) => send(res, 200, authorizationServerMetadata(origin), CORS),

    "POST /oauth/register": async (req, res) => {
      if (await limited("register", clientIp(req)) || await limited("registerGlobal", "all")) {
        await usage({ rateLimited: 1 });
        return send(res, 429, { error: "too_many_requests", error_description: "Too many registrations; try again later." }, CORS);
      }
      try {
        return send(res, 201, await registerClient(db, bodyOf(req), { now: now() }), CORS);
      } catch (error) {
        if (error instanceof ClientError) return send(res, 400, { error: error.error, error_description: error.message }, CORS);
        throw error;
      }
    },

    "GET /oauth/authorize": async (req, res) => {
      if (await limited("authorize", clientIp(req))) return errorPage(res, 429, "Too many attempts. Wait a few minutes and try again.");
      const result = await oauth.authorize(queryOf(req));
      if (result.page) return errorPage(res, result.page.status, result.page.message);
      return send(res, 302, undefined, { Location: result.redirect });
    },

    "POST /oauth/consent": async (req, res) => {
      if (await limited("consent", clientIp(req))) return send(res, 429, { error: "too_many_requests", error_description: "Too many attempts. Wait a few minutes." });
      return send(res, 200, await oauth.consentInfo(bodyOf(req)));
    },

    "POST /oauth/approve": async (req, res) => {
      if (await limited("approve", clientIp(req))) return send(res, 429, { error: "too_many_requests", error_description: "Too many attempts. Wait a few minutes." });
      return send(res, 200, await oauth.decide(bodyOf(req)));
    },

    "POST /oauth/token": async (req, res) => send(res, 200, await oauth.token(bodyOf(req), basicAuth(req)), { ...CORS, Pragma: "no-cache" }),

    "POST /oauth/revoke": async (req, res) => {
      await oauth.revoke(bodyOf(req), basicAuth(req));
      return send(res, 200, {}, CORS);
    },
  };

  return async (req, res) => {
    const path = pathOf(req).replace(/\/+$/, "") || "/";
    if (req.method === "OPTIONS") return send(res, 204, undefined, CORS);
    const route = routes[`${req.method} ${path}`];
    if (!route) {
      const known = Object.keys(routes).some((key) => key.endsWith(` ${path}`));
      return send(res, known ? 405 : 404, { error: known ? "method_not_allowed" : "not_found" }, CORS);
    }
    try {
      await route(req, res);
    } catch (error) {
      if (error instanceof OAuthError) {
        const headers = { ...CORS };
        if (error.status === 401 && error.error === "invalid_client" && req.headers.authorization?.startsWith("Basic ")) {
          headers["WWW-Authenticate"] = "Basic realm=\"Always On Time\"";
        }
        return send(res, error.status, { error: error.error, error_description: error.message }, headers);
      }
      if (error instanceof SyntaxError) return send(res, 400, { error: "invalid_request", error_description: "malformed body" }, CORS);
      logger?.error?.("Assistant OAuth request failed", { path, name: error?.name, message: error?.message });
      return send(res, 500, { error: "server_error" }, CORS);
    }
  };
}

module.exports = { basicAuth, createOAuthHandler, send };

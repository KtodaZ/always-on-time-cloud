"use strict";

// The assistant connector's MCP endpoint: Streamable HTTP in stateless JSON mode behind OAuth
// bearer tokens. Each request builds a server bound to the token's account, so a tool can only
// ever read or write the signed-in user's data.

const { admitDirect, clientKeys, createInstanceLimiters } = require("./assistant-limits");
const { COLLECTIONS } = require("./assistant-data");
const { errorFields, logEvent } = require("./assistant-log");
const { LAST_USED_RESOLUTION_MS, SCOPES, grantLogId, movedUrl, urls, verifyAccessToken } = require("./assistant-oauth");
const { ToolError } = require("./assistant-snapshot");
const { createToolContext } = require("./assistant-tool-context");
const { INSTRUCTIONS, TOOLS, noPhone } = require("./assistant-tools");
const { day, week } = require("./assistant-usage");

const SLOW_MS = 5000;
// JSON-RPC batches are refused above this many messages (MCP 2025-06-18 dropped batching).
const MAX_BATCH = 5;
const ACCESS_TOKEN = /^aot_at_[A-Za-z0-9_-]{43}$/;
const SERVER_VERSION = "1.0.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  "Access-Control-Max-Age": "600",
};

function sendJson(res, status, body, headers = {}) {
  res.statusCode = status;
  for (const [name, value] of Object.entries({ ...CORS, "Cache-Control": "no-store", ...headers })) res.setHeader(name, value);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

const bearer = (req) => {
  const header = req.headers.authorization;
  return typeof header === "string" && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : null;
};

/**
 * Builds the MCP request handler. `deps`: db, messaging,
 * usage(counts), accountEmails(uid), logger, now, sleep, origin, legacyHosts, sdk ({McpServer,
 * StreamableHTTPServerTransport}; loaded lazily so other functions don't pay for it).
 */
function createMcpHandler(deps) {
  const { db, logger, now = Date.now, usage = async () => {} } = deps;
  // Refused requests are counted in memory and written with the next usage update (no write of their own).
  const deferUsage = (counts) => usage.defer?.(counts);
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const u = urls(deps.origin);
  const limiters = deps.limiters ?? createInstanceLimiters();
  const hosts = [new URL(u.origin).host, ...(deps.legacyHosts ?? [])];
  const challenge = (extra = "") => `Bearer resource_metadata="${u.resourceMetadata}", scope="${SCOPES.join(" ")}"${extra}`;

  /** Records last use at most hourly, and counts the connection once per day and week. */
  async function touch(grant) {
    const time = now();
    const today = day(time);
    const thisWeek = week(time);
    const update = {};
    if ((grant.lastUsedAt ?? 0) + LAST_USED_RESOLUTION_MS < time) update.lastUsedAt = new Date(time);
    const counts = {};
    if (grant.lastActiveDay !== today) {
      update.lastActiveDay = today;
      counts[`activeConnections.${grant.assistant}`] = 1;
    }
    if (grant.lastActiveWeek !== thisWeek) {
      update.lastActiveWeek = thisWeek;
      counts[`weeklyActive.${grant.assistant}`] = 1;
    }
    if (Object.keys(update).length) {
      await db.collection(COLLECTIONS.grants).doc(grant.grantId).update(update).catch((error) => {
        logEvent(logger, "warn", "grant.touch_failed", { logId: grant.logId, grantId: grant.grantId, ...errorFields(error) });
      });
    }
    if (Object.keys(counts).length) await usage(counts);
  }

  function buildServer(grant) {
    const { McpServer } = deps.sdk;
    const server = new McpServer(
      { name: "always-on-time", title: "Always On Time", version: SERVER_VERSION },
      { instructions: INSTRUCTIONS },
    );
    for (const tool of TOOLS) {
      server.registerTool(tool.name, {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title, ...tool.annotations },
      }, async (args) => runTool(tool, createToolContext({
        db, uid: grant.uid, grant, origin: u.origin, now, sleep, messaging: deps.messaging, logger, accountEmails: deps.accountEmails,
      }), args ?? {}));
    }
    return server;
  }

  async function runTool(tool, ctx, args) {
    const started = now();
    // ctx.counts are written as one usage update when the call finishes.
    ctx.count(`tools.${tool.name}`);
    let response;
    let outcome = "ok";
    let failure = {};
    let refused = false;
    try {
      const needed = tool.scope === "write" ? "alarms.write" : "alarms.read";
      if (!ctx.grant.scopes.includes(needed)) {
        throw new ToolError(tool.scope === "write"
          ? "This connection can only read. Reconnect the assistant and allow changes to make changes."
          : "This connection isn't allowed to read alarms.");
      }
      if (!limiters.toolCalls(ctx.grant.grantId, started)) {
        ctx.count("rateLimited");
        refused = true;
        throw new ToolError("Too many requests in a short time. Wait a few minutes and try again.");
      }
      const out = await tool.handler(ctx, args);
      response = { content: [{ type: "text", text: out.text }], structuredContent: out.data ?? {} };
    } catch (error) {
      if (error?.noPhone) {
        outcome = "no_phone";
        const out = noPhone(ctx);
        response = { content: [{ type: "text", text: out.text }], structuredContent: out.data };
      } else if (error instanceof ToolError) {
        // The message can quote an event title, so only the outcome is logged.
        outcome = refused ? "rate_limited" : "tool_error";
        ctx.count(`errors.${tool.name}`);
        response = { content: [{ type: "text", text: error.message }], structuredContent: { error: error.message, ...error.data }, isError: true };
      } else {
        outcome = "unexpected_error";
        failure = errorFields(error);
        ctx.count(`errors.${tool.name}`);
        response = { content: [{ type: "text", text: "Something went wrong on the Always On Time server. Try again in a moment." }], isError: true };
      }
    }
    const durationMs = now() - started;
    if (refused) {
      // Logged once per window; counted without a database write.
      if (limiters.toolCalls.count(ctx.grant.grantId, started) === limiters.toolCalls.limit + 1) {
        logEvent(logger, "warn", "tool.call", { tool: tool.name, outcome, logId: ctx.logId, grantId: ctx.grant.grantId });
      }
      deferUsage(ctx.counts);
      return response;
    }
    if (!tool.waits && durationMs > SLOW_MS) ctx.count(`slow.${tool.name}`);
    // One line per call (assistant-log.js keeps it to ids, never arguments or results).
    logEvent(logger, outcome === "unexpected_error" ? "error" : "info", "tool.call", {
      tool: tool.name,
      outcome,
      durationMs,
      logId: ctx.logId,
      grantId: ctx.grant.grantId,
      client: ctx.grant.clientName,
      assistant: ctx.grant.assistant,
      ...ctx.trace,
      ...failure,
    });
    await usage(ctx.counts);
    return response;
  }

  return async (req, res) => {
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      for (const [name, value] of Object.entries(CORS)) res.setHeader(name, value);
      res.end();
      return;
    }
    const tooMany = (reason) => {
      deferUsage({ rateLimited: 1 });
      logEvent(logger, "warn", "oauth.token_rejected", { reason: "rate_limited", kind: reason });
      return sendJson(res, 429, { error: "too_many_requests", error_description: "Too many unauthenticated requests; try again later." }, { "Retry-After": "60" });
    };
    // Not a redirect: MCP clients drop the Authorization header when a redirect changes the host,
    // and a token or resource for the old URL can't be used on this one, so the assistant has to
    // be set up again with the new URL. The JSON-RPC error says so.
    if (movedUrl(req, u.origin, deps.legacyHosts)) {
      logEvent(logger, "info", "host.moved", { path: "/mcp", status: 410 });
      return sendJson(res, 410, { jsonrpc: "2.0", error: {
        code: -32000,
        message: `Always On Time's connector moved to ${u.mcp}. Remove this connector from your assistant and add it again with that URL.`,
      }, id: null });
    }
    const time = now();
    const from = clientKeys(req, { hosts });
    if (!admitDirect(limiters, from, time)) return tooMany("direct");
    // Batches are refused before any database read.
    const messages = Array.isArray(req.body) ? req.body.length : 1;
    if (Array.isArray(req.body) && (messages === 0 || messages > MAX_BATCH)) {
      return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32600, message: `Send at most ${MAX_BATCH} JSON-RPC messages per request.` }, id: null });
    }
    const token = bearer(req);
    const unauthorized = (reason) => sendJson(res, 401, { error: "invalid_token", error_description: "Sign in to Always On Time to use this connector." }, {
      "WWW-Authenticate": challenge(reason === "missing" ? "" : ", error=\"invalid_token\""),
    });
    // A missing or malformed token is refused without a database read. They cost nothing, so they
    // are only counted to keep the log quiet during a flood.
    if (!token || !ACCESS_TOKEN.test(token)) {
      const reason = token ? "malformed" : "missing";
      if (limiters.unauthorized(from.client, time) && limiters.unauthorizedGlobal(from.scope, time)) {
        logEvent(logger, "info", "oauth.token_rejected", { reason });
      }
      return unauthorized(reason);
    }
    // A well-formed token is always verified first, so failed attempts by others never lock out
    // a token that works; only a failed verification counts against the failure limits.
    let rejected = null;
    const grant = await verifyAccessToken(db, token, { now: time, onReject: (reason) => { rejected = reason; } });
    if (!grant) {
      const counted = [limiters.unauthorized(from.client, time), limiters.unauthorizedGlobal(from.scope, time)];
      if (!counted.every(Boolean)) return tooMany(rejected ?? "invalid");
      logEvent(logger, "info", "oauth.token_rejected", { reason: rejected ?? "invalid" });
      return unauthorized(rejected ?? "invalid");
    }
    // Every JSON-RPC message counts against the connection's allowance, initialize and tools/list included.
    if (!limiters.mcpMessages(grant.grantId, time, messages)) {
      deferUsage({ rateLimited: 1 });
      if (limiters.mcpMessages.count(grant.grantId, time) - messages < limiters.mcpMessages.limit) {
        logEvent(logger, "warn", "mcp.rate_limited", { logId: grant.logId, grantId: grant.grantId, reason: "messages" });
      }
      return sendJson(res, 429, { jsonrpc: "2.0", error: { code: -32000, message: "Too many requests in a short time. Wait a few minutes and try again." }, id: null }, { "Retry-After": "600" });
    }
    if (req.method !== "POST") {
      // Stateless server: no server-initiated streams or sessions to resume or end.
      return sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, { Allow: "POST, OPTIONS" });
    }
    for (const [name, value] of Object.entries(CORS)) res.setHeader(name, value);
    res.setHeader("Cache-Control", "no-store");
    if (!grant.logId) {
      // A connection made before logIds existed gets one once; the request goes ahead without it if that fails.
      grant.logId = await grantLogId(db, grant, now()).catch((error) => {
        logEvent(logger, "warn", "grant.log_id_failed", { grantId: grant.grantId, ...errorFields(error) });
        return null;
      });
    }
    await touch(grant);
    const server = buildServer(grant);
    const transport = new deps.sdk.StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logEvent(logger, "error", "mcp.request_failed", { logId: grant.logId, grantId: grant.grantId, ...errorFields(error) });
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  };
}

function loadSdk() {
  const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
  const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
  return { McpServer, StreamableHTTPServerTransport };
}

module.exports = { createMcpHandler, loadSdk };

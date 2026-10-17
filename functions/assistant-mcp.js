"use strict";

// The assistant connector's MCP endpoint: Streamable HTTP in stateless JSON mode behind OAuth
// bearer tokens. Each request builds a server bound to the token's account, so a tool can only
// ever read or write the signed-in user's data.

const { LIMITS, createMemoryLimiter, consume } = require("./assistant-limits");
const { COLLECTIONS } = require("./assistant-data");
const { errorFields, logEvent } = require("./assistant-log");
const { LAST_USED_RESOLUTION_MS, SCOPES, urls, verifyAccessToken } = require("./assistant-oauth");
const { ToolError } = require("./assistant-snapshot");
const { INSTRUCTIONS, TOOLS, noPhone } = require("./assistant-tools");
const { day, week } = require("./assistant-usage");

const SLOW_MS = 5000;
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

const memoryLimiter = createMemoryLimiter(LIMITS.toolCalls);

/**
 * Builds the MCP request handler. `deps`: db, messaging,
 * usage(counts), accountEmails(uid), logger, now, sleep, origin, sdk ({McpServer,
 * StreamableHTTPServerTransport}; loaded lazily so other functions don't pay for it).
 */
function createMcpHandler(deps) {
  const { db, logger, now = Date.now, usage = async () => {} } = deps;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const u = urls(deps.origin);
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
    if (Object.keys(update).length) await db.collection(COLLECTIONS.grants).doc(grant.grantId).update(update).catch(() => {});
    if (Object.keys(counts).length) await usage(counts);
  }

  function buildServer(grant) {
    const { McpServer } = deps.sdk;
    const server = new McpServer(
      { name: "always-on-time", title: "Always On Time", version: SERVER_VERSION },
      { instructions: INSTRUCTIONS },
    );
    const ctx = {
      db,
      uid: grant.uid,
      grant,
      origin: u.origin,
      now,
      sleep,
      messaging: deps.messaging,
      logger,
      accountEmails: () => deps.accountEmails(grant.uid),
      pushAllowed: () => consume(db, `push|${grant.grantId}`, LIMITS.push, now()),
      confirmSetup: async () => {
        grant.setupConfirmedAt = now();
        await db.collection(COLLECTIONS.grants).doc(grant.grantId).update({ setupConfirmedAt: new Date(grant.setupConfirmedAt) });
      },
    };
    for (const tool of TOOLS) {
      server.registerTool(tool.name, {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title, ...tool.annotations },
      }, async (args) => runTool(tool, { ...ctx, counts: {}, trace: {} }, args ?? {}));
    }
    return server;
  }

  async function runTool(tool, ctx, args) {
    const started = now();
    // Counters for this call, written as one usage update when it finishes.
    ctx.count = (name, amount = 1) => {
      ctx.counts[name] = (ctx.counts[name] ?? 0) + amount;
    };
    ctx.count(`tools.${tool.name}`);
    let response;
    let outcome = "ok";
    let failure = {};
    try {
      const needed = tool.scope === "write" ? "alarms.write" : "alarms.read";
      if (!ctx.grant.scopes.includes(needed)) {
        throw new ToolError(tool.scope === "write"
          ? "This connection can only read. Reconnect the assistant and allow changes to make changes."
          : "This connection isn't allowed to read alarms.");
      }
      if (!memoryLimiter(ctx.grant.grantId, started)) {
        ctx.count("rateLimited");
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
        outcome = "tool_error";
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
    if (!tool.waits && durationMs > SLOW_MS) ctx.count(`slow.${tool.name}`);
    // One line per call (assistant-log.js keeps it to ids, never arguments or results).
    logEvent(logger, outcome === "unexpected_error" ? "error" : "info", "tool.call", {
      tool: tool.name,
      outcome,
      durationMs,
      uid: ctx.uid,
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
    const token = bearer(req);
    let rejected = token ? null : "missing";
    const grant = token ? await verifyAccessToken(db, token, { now: now(), onReject: (reason) => { rejected = reason; } }) : null;
    if (!grant) {
      logEvent(logger, "info", "oauth.token_rejected", { reason: rejected ?? "invalid" });
      return sendJson(res, 401, { error: "invalid_token", error_description: "Sign in to Always On Time to use this connector." }, {
        "WWW-Authenticate": challenge(token ? ", error=\"invalid_token\"" : ""),
      });
    }
    if (req.method !== "POST") {
      // Stateless server: no server-initiated streams or sessions to resume or end.
      return sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, { Allow: "POST, OPTIONS" });
    }
    for (const [name, value] of Object.entries(CORS)) res.setHeader(name, value);
    res.setHeader("Cache-Control", "no-store");
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
      logEvent(logger, "error", "mcp.request_failed", { uid: grant.uid, grantId: grant.grantId, ...errorFields(error) });
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

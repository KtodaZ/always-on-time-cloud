"use strict";

// Abuse limits for the assistant connector's OAuth endpoints: who a request comes from, failure-only
// overall caps, per-grant token limits and the metadata fetch budget.

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const http = require("node:http");
const test = require("node:test");

const { FakeFirestore } = require("../testing/fake-firestore");
const { createOAuth } = require("../assistant-oauth");
const { getClient } = require("../assistant-oauth-clients");
const { createOAuthHandler, presentedGrant } = require("../assistant-oauth-http");
const { clientKeys, createInstanceLimiters, createMemoryLimiter, isHostingProxy, networkKey } = require("../assistant-limits");
const { createRecordingMessaging } = require("../assistant-push");
const { createUsage } = require("../assistant-usage");

const ORIGIN = "https://alwaysontime.zombit.io";
const CLAUDE_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const T0 = Date.parse("2026-10-16T12:00:00Z");
const VERIFIER = "v".repeat(43) + "erifier-with-enough-entropy";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const HOSTS = ["alwaysontime.zombit.io"];

/** Headers of a request that came through Hosting from `visitor`. */
const viaHosting = (visitor) => ({ "x-forwarded-for": `${visitor}, 66.249.84.6`, "x-forwarded-host": "alwaysontime.zombit.io", "fastly-client-ip": visitor });

function setup() {
  const db = new FakeFirestore();
  db.now = () => T0;
  const oauth = createOAuth({
    db,
    origin: ORIGIN,
    now: () => T0,
    messaging: createRecordingMessaging(),
    verifyIdToken: async (token) => ({ uid: token.slice(3), email: "a@example.com", firebase: { sign_in_provider: "google.com", identities: { "google.com": ["g"] } } }),
    fetchMetadata: async () => ({ client_id: CLAUDE_ID, client_name: "Claude", redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: "none" }),
  });
  db.documents.set("accounts/alice", { active: true, schemaVersion: 1 });
  const limiters = createInstanceLimiters();
  const usage = createUsage({ db, increment: (n) => ({ __increment: n }), now: () => T0 });
  const handler = createOAuthHandler({ oauth, db, now: () => T0, limiters, usage });
  return { db, oauth, limiters, handler };
}

async function withServer(handler, run) {
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    req.body = text;
    await handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const form = (path, fields, headers = {}) => fetch(`${base}${path}`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString(),
  });
  const json = (path, body, headers = {}) => fetch(`${base}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  try {
    await run({ base, form, json });
  } finally {
    server.close();
  }
}

/** Connects Alice through the OAuth API (no HTTP limits involved) and returns her tokens. */
async function connect(oauth) {
  const { redirect } = await oauth.authorize({
    response_type: "code", client_id: CLAUDE_ID, redirect_uri: CLAUDE_REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256",
  });
  const approved = await oauth.decide({ request: new URL(redirect).searchParams.get("request"), idToken: "id:alice", decision: "approve" });
  const code = new URL(approved.redirect).searchParams.get("code");
  return oauth.token({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: CLAUDE_ID, redirect_uri: CLAUDE_REDIRECT });
}

test("only requests from Google's front end with this service's host are keyed by the visitor", () => {
  assert.deepEqual(clientKeys({ headers: viaHosting("198.51.100.7") }, { hosts: HOSTS }),
    { client: "ip:198.51.100.7", hop: "66.249.84.6", direct: false, scope: "all" });
  // A direct call forging every Hosting header is keyed by its own (unforgeable) hop.
  const forged = { ...viaHosting("198.51.100.7"), "x-forwarded-for": "198.51.100.7, 203.0.113.9" };
  assert.deepEqual(clientKeys({ headers: forged }, { hosts: HOSTS }), { client: "direct:203.0.113.9", hop: "203.0.113.9", direct: true, scope: "direct" });
  // Google's front end, but not for this host.
  assert.equal(clientKeys({ headers: { ...viaHosting("198.51.100.7"), "x-forwarded-host": "evil.example" } }, { hosts: HOSTS }).direct, true);
  assert.equal(clientKeys({ headers: { ...viaHosting("198.51.100.7"), "x-forwarded-host": undefined } }, { hosts: HOSTS }).direct, true);
  // Through Hosting without a usable visitor address: the front end's address, still apart from direct calls.
  assert.equal(clientKeys({ headers: { ...viaHosting("198.51.100.7"), "fastly-client-ip": "nonsense" } }, { hosts: HOSTS }).client, "proxy:66.249.84.6");
  // IPv6 visitors are grouped by /64.
  assert.equal(clientKeys({ headers: viaHosting("2001:db8:1:2:aaaa::1") }, { hosts: HOSTS }).client, "ip:2001:0db8:0001:0002::/64");
  assert.equal(networkKey("2001:db8:1:2:bbbb::9"), "2001:0db8:0001:0002::/64");
  assert.equal(networkKey("::ffff:192.0.2.1"), "192.0.2.1");
  for (const address of ["66.249.84.6", "74.125.209.2", "2607:f8b0:4000::1"]) assert.ok(isHostingProxy(address), address);
  for (const address of ["34.120.0.1", "203.0.113.9", "127.0.0.1", "nonsense"]) assert.ok(!isHostingProxy(address), address);
});

test("the token endpoint never refuses a valid refresh because of other callers' failures", async () => {
  const { oauth, limiters, handler } = setup();
  const tokens = await connect(oauth);
  await withServer(handler, async ({ form }) => {
    const claude = viaHosting("198.51.100.7");
    const junk = (i) => ({ grant_type: "refresh_token", client_id: CLAUDE_ID, refresh_token: `aot_rt_${String(i).padStart(43, "j")}` });
    // Junk from the assistant's own address uses up its failure budget...
    for (let i = 0; i < limiters.tokenFailures.limit; i += 1) assert.equal((await form("/oauth/token", junk(i), claude)).status, 400);
    assert.equal((await form("/oauth/token", junk(999), claude)).status, 429);
    // ...and junk from many addresses the overall failure cap.
    for (let i = 0; i < limiters.tokenFailuresGlobal.limit; i += 1) await form("/oauth/token", junk(i), viaHosting(`192.0.2.${i % 200}`));
    assert.equal((await form("/oauth/token", junk(1000), viaHosting("192.0.2.250"))).status, 429);
    // A refresh token that exists is still served, from the same address.
    const refreshed = await form("/oauth/token", { grant_type: "refresh_token", client_id: CLAUDE_ID, refresh_token: tokens.refresh_token }, claude);
    assert.equal(refreshed.status, 200);
    assert.match((await refreshed.json()).access_token, /^aot_at_/);
  });
});

test("token requests are limited per presented grant, and malformed ones cost no read", async () => {
  const { db, limiters, handler } = setup();
  await withServer(handler, async ({ form }) => {
    const reads = db.reads;
    for (const fields of [{ grant_type: "password", client_id: CLAUDE_ID }, { grant_type: "refresh_token", refresh_token: `aot_rt_${"x".repeat(43)}` },
      { grant_type: "refresh_token", client_id: CLAUDE_ID, refresh_token: "aot_rt_short" }]) {
      assert.ok([400, 401].includes((await form("/oauth/token", fields, viaHosting("198.51.100.8"))).status));
    }
    assert.equal(db.reads, reads, "no Firestore read for requests that can't succeed");
    const same = { grant_type: "refresh_token", client_id: CLAUDE_ID, refresh_token: `aot_rt_${"r".repeat(43)}` };
    const statuses = [];
    // From different addresses, so only the per-grant limit applies.
    for (let i = 0; i <= limiters.tokenGrant.limit; i += 1) statuses.push((await form("/oauth/token", same, viaHosting(`192.0.2.${i}`))).status);
    assert.equal(statuses.at(-1), 429);
    assert.equal(statuses.filter((status) => status === 429).length, 1);
  });
  assert.equal(presentedGrant({ grant_type: "refresh_token", client_id: "c", refresh_token: `aot_rt_${"x".repeat(43)}` }).id,
    createHash("sha256").update(`aot_rt_${"x".repeat(43)}`).digest("hex"));
  assert.equal(presentedGrant({ grant_type: "refresh_token", client_id: "c", refresh_token: "aot_rt_x" }), null);
});

test("overall OAuth caps count failures only, so valid traffic never fills them", async () => {
  const { limiters, handler } = setup();
  await withServer(handler, async ({ base }) => {
    const authorize = (headers, clientId = CLAUDE_ID) => fetch(`${base}/oauth/authorize?${new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: CLAUDE_REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256",
    })}`, { redirect: "manual", headers });
    // More valid requests than the overall failure cap, from many visitors.
    for (let i = 0; i < limiters.authorizeFailuresGlobal.limit + 20; i += 1) {
      assert.equal((await authorize(viaHosting(`10.0.${Math.floor(i / 50)}.${i % 50}`))).status, 302, `request ${i}`);
    }
    // Failures (an unknown client) fill it, and then requests are refused.
    for (let i = 0; i < limiters.authorizeFailuresGlobal.limit; i += 1) {
      assert.equal((await authorize(viaHosting(`172.16.${Math.floor(i / 25)}.${i % 25}`), "aot_client_unknown")).status, 400);
    }
    assert.equal((await authorize(viaHosting("192.0.2.77"), "aot_client_unknown")).status, 429);
    // Direct calls have their own budget, so they didn't share in any of this.
    assert.equal((await authorize({ "x-forwarded-for": "203.0.113.5" })).status, 302);
  });
});

test("only valid registrations count against the registration limits, and refusals cost no write", async () => {
  const { db, limiters, handler } = setup();
  await withServer(handler, async ({ json }) => {
    const visitor = viaHosting("198.51.100.9");
    for (let i = 0; i < limiters.registerFailures.limit; i += 1) {
      assert.equal((await json("/oauth/register", { redirect_uris: ["http://evil.example/cb"] }, visitor)).status, 400);
    }
    assert.equal((await json("/oauth/register", { redirect_uris: ["http://evil.example/cb"] }, visitor)).status, 429);
    const other = viaHosting("198.51.100.10");
    const statuses = [];
    for (let i = 0; i < 31; i += 1) statuses.push((await json("/oauth/register", { redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "none" }, other)).status);
    assert.equal(statuses.filter((status) => status === 201).length, 30);
    assert.equal(statuses.at(-1), 429);
    const writes = db.writes;
    assert.equal((await json("/oauth/register", { redirect_uris: ["https://a.example/cb"] }, other)).status, 429);
    assert.equal(db.writes, writes, "the refusal itself writes nothing");
  });
});

test("metadata fetches for Claude and ChatGPT are never refused by the shared fetch budgets", async () => {
  const db = new FakeFirestore();
  const limiters = createInstanceLimiters();
  const ok = async (url) => ({ client_id: url, redirect_uris: ["https://cb.example/cb"] });
  // Junk on the branded host and elsewhere uses up the per-host and overall budgets.
  for (let i = 0; i < limiters.metadataFetchGlobal.limit + 5; i += 1) {
    await getClient(db, `https://many${i % 3}.example/c${i}`, { now: T0, fetchMetadata: ok, fetch: true, limiters }).catch(() => {});
    await getClient(db, `https://claude.ai/junk${i}`, { now: T0, fetchMetadata: async () => { throw new Error("404"); }, fetch: true, limiters }).catch(() => {});
  }
  await assert.rejects(getClient(db, "https://many0.example/new", { now: T0, fetchMetadata: ok, fetch: true, limiters }), /too many client metadata fetches/);
  let fetched = 0;
  const claude = await getClient(db, CLAUDE_ID, {
    now: T0, fetchMetadata: async (url) => { fetched += 1; return { client_id: url, redirect_uris: [CLAUDE_REDIRECT] }; }, fetch: true, limiters,
  });
  assert.equal(fetched, 1);
  assert.equal(claude.clientName, "Claude");
  const chatgpt = await getClient(db, "https://chatgpt.com/oauth/client.json", {
    now: T0, fetchMetadata: async (url) => ({ client_id: url, redirect_uris: ["https://chatgpt.com/connector/oauth/cb"] }), fetch: true, limiters,
  });
  assert.equal(chatgpt.clientName, "ChatGPT");
  // The overall budget wasn't spent by the branded fetches either.
  const fresh = createInstanceLimiters();
  assert.ok(fresh.metadataFetchHost("claude.ai", T0) && fresh.metadataFetchGlobal("all", T0));
  assert.equal(fresh.metadataFetchGlobal.count("all", T0), 0);
});

test("memory limiters count weights and report their count", () => {
  const limiter = createMemoryLimiter({ limit: 5, windowMs: 1000 });
  assert.equal(limiter("a", 0, 3), true);
  assert.equal(limiter("a", 1, 2), true);
  assert.equal(limiter.exceeded("a", 2), true);
  assert.equal(limiter("a", 3), false);
  assert.equal(limiter.count("a", 3), 6);
  assert.equal(limiter("a", 1000), true, "a new window");
});

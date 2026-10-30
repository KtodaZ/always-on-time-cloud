"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const http = require("node:http");
const test = require("node:test");

const { FakeFirestore } = require("../testing/fake-firestore");
const {
  LEGACY_HOSTS, OAuthError, PRODUCTION_ORIGIN, REFRESH_REUSE_GRACE_MS, REUSE_GRACE_MS, authorizationServerMetadata, createOAuth, movedUrl,
  protectedResourceMetadata, verifyAccessToken,
} = require("../assistant-oauth");
const {
  ClientError, fetchClientMetadata, getClient, isPublicAddress, isValidRedirectUri, parseClientIdUrl, redirectMatches,
  registerClient, validateClientMetadata,
} = require("../assistant-oauth-clients");
const { createOAuthHandler } = require("../assistant-oauth-http");
const { createRecordingMessaging } = require("../assistant-push");

const ORIGIN = "https://alwaysontime.zombit.io";
const MCP = `${ORIGIN}/mcp`;
const CLAUDE_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const T0 = Date.parse("2026-10-16T12:00:00Z");
const VERIFIER = "v".repeat(43) + "erifier-with-enough-entropy";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

function setup({ metadata, demoUid } = {}) {
  const db = new FakeFirestore();
  const logs = [];
  const logger = Object.fromEntries(["info", "warn", "error"].map((level) => [level, (message, fields) => logs.push({ level, message, ...fields })]));
  let time = Date.parse("2026-10-16T12:00:00Z");
  const messaging = createRecordingMessaging();
  const counts = [];
  const fetches = [];
  const oauth = createOAuth({
    db,
    now: () => time,
    messaging,
    logger,
    usage: async (c) => counts.push(c),
    demoUid,
    verifyIdToken: async (token) => {
      // "pw:<uid>" is a password sign-in; "pwg:<uid>" / "pwa:<uid>" one to an account that also has
      // Google / Apple linked.
      const password = /^pw[ga]?:/.exec(token);
      if (password) {
        const uid = token.slice(password[0].length);
        const linked = { "pwg:": { "google.com": ["g"] }, "pwa:": { "apple.com": ["a"] } }[password[0]] ?? {};
        return { uid, email: `${uid}@example.com`, firebase: { sign_in_provider: "password", identities: {
          email: [`${uid}@example.com`], ...linked,
        } } };
      }
      // "ap:<uid>" is a Sign in with Apple session that hid its email (none in the token); "apx:<uid>"
      // claims apple.com as the provider without an Apple identity.
      const apple = /^apx?:/.exec(token);
      if (apple) {
        const uid = token.slice(apple[0].length);
        return { uid, firebase: { sign_in_provider: "apple.com", identities: apple[0] === "ap:" ? { "apple.com": ["a"] } : {} } };
      }
      if (!token.startsWith("id:")) throw new Error("bad token");
      const uid = token.slice(3);
      return { uid, email: `${uid}@example.com`, firebase: uid.startsWith("anon")
        ? { sign_in_provider: "anonymous", identities: {} }
        : { sign_in_provider: "google.com", identities: { "google.com": ["g"] } } };
    },
    fetchMetadata: async (url) => {
      fetches.push(url);
      return metadata ?? { client_id: CLAUDE_ID, client_name: "Claude", redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: "none" };
    },
  });
  db.documents.set("accounts/alice", { active: true, schemaVersion: 1 });
  return { db, oauth, messaging, counts, fetches, logs, clock: { advance: (ms) => { time += ms; }, now: () => time } };
}

const requestIdFrom = (redirect) => new URL(redirect).searchParams.get("request");

async function approveCode(oauth, { clientId = CLAUDE_ID, redirectUri = CLAUDE_REDIRECT, uid = "alice", state = "s1" } = {}) {
  const { redirect } = await oauth.authorize({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: CHALLENGE,
    code_challenge_method: "S256", state, resource: MCP, scope: "alarms.read alarms.write",
  });
  assert.ok(redirect.startsWith(`${ORIGIN}/connect/?request=`), redirect);
  const approved = await oauth.decide({ request: requestIdFrom(redirect), idToken: `id:${uid}`, decision: "approve" });
  const url = new URL(approved.redirect);
  assert.equal(url.searchParams.get("state"), state);
  assert.equal(url.searchParams.get("iss"), ORIGIN);
  return url.searchParams.get("code");
}

async function connect(oauth, options = {}) {
  const code = await approveCode(oauth, options);
  return oauth.token({
    grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: options.clientId ?? CLAUDE_ID,
    redirect_uri: options.redirectUri ?? CLAUDE_REDIRECT, resource: MCP,
  });
}

test("discovery documents name this server, its endpoints and S256 PKCE", () => {
  const resource = protectedResourceMetadata(ORIGIN);
  assert.equal(resource.resource, MCP);
  assert.deepEqual(resource.authorization_servers, [ORIGIN]);
  const server = authorizationServerMetadata(ORIGIN);
  assert.equal(server.issuer, ORIGIN);
  assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
  assert.equal(server.client_id_metadata_document_supported, true);
  assert.equal(server.registration_endpoint, `${ORIGIN}/oauth/register`);
});

test("a full connection issues opaque tokens, stores only hashes and marks the account connected", async () => {
  const { db, oauth, counts } = setup();
  const tokens = await connect(oauth);
  assert.match(tokens.access_token, /^aot_at_[A-Za-z0-9_-]{43}$/);
  assert.match(tokens.refresh_token, /^aot_rt_[A-Za-z0-9_-]{43}$/);
  assert.equal(tokens.expires_in, 3600);
  assert.equal(tokens.scope, "alarms.read alarms.write");
  const stored = JSON.stringify(db.dump());
  assert.equal(stored.includes(tokens.access_token), false, "raw tokens are never stored");
  assert.equal(stored.includes(tokens.refresh_token), false);
  const state = db.documents.get("accounts/alice/assistant/state");
  assert.deepEqual([state.connected, state.connections], [true, 1]);
  const grant = await verifyAccessToken(db, tokens.access_token, { now: Date.parse("2026-10-16T12:30:00Z") });
  assert.equal(grant.uid, "alice");
  assert.equal(grant.clientName, "Claude");
  assert.equal(grant.assistant, "claude");
  assert.deepEqual(grant.scopes, ["alarms.read", "alarms.write"]);
  assert.equal(await verifyAccessToken(db, tokens.access_token, { now: Date.parse("2026-10-16T13:00:01Z") }), null, "access tokens last an hour");
  assert.equal(await verifyAccessToken(db, tokens.refresh_token, { now: T0 }), null, "refresh tokens are not access tokens");
  assert.equal(await verifyAccessToken(db, "aot_at_unknown", { now: T0 }), null);
  assert.ok(counts.some((c) => c["connectionsNew.claude"] === 1));
});

test("the OAuth flow logs each step with ids and reasons, never tokens, codes or redirect URIs", async () => {
  const { db, oauth, logs, clock } = setup();
  const tokens = await connect(oauth);
  await oauth.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: CLAUDE_ID });
  clock.advance(REFRESH_REUSE_GRACE_MS + 1);
  await assert.rejects(oauth.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: CLAUDE_ID }));
  const events = logs.map((entry) => `${entry.assistantEvent}:${entry.outcome ?? entry.reason}`);
  assert.deepEqual(events, [
    "oauth.client_metadata:registered", "oauth.authorize:consent", "oauth.consent:approved", "oauth.code_exchange:ok",
    "oauth.refresh:ok", "oauth.refresh:rejected", "connection.revoked:refresh_reuse",
  ]);
  const exchange = logs.find((entry) => entry.assistantEvent === "oauth.code_exchange");
  // The account appears only as its logId, the one stored in assistant/log and on the grant.
  const { logId } = db.documents.get("accounts/alice/assistant/log");
  assert.match(logId, /^log_[A-Za-z0-9_-]{16}$/);
  for (const event of ["oauth.consent", "oauth.code_exchange", "oauth.refresh", "connection.revoked"]) {
    assert.equal(logs.find((entry) => entry.assistantEvent === event).logId, logId, event);
  }
  assert.match(exchange.grantId, /^[0-9a-f-]{36}$/);
  assert.equal(exchange.clientId, CLAUDE_ID);
  assert.equal(logs.find((entry) => entry.assistantEvent === "connection.revoked").grantId, exchange.grantId);
  const text = JSON.stringify(logs);
  assert.ok(logs.every((entry) => !("uid" in entry)));
  for (const secret of ["alice", "aot_at_", "aot_rt_", "aot_code_", VERIFIER, CHALLENGE, CLAUDE_REDIRECT]) {
    assert.ok(!text.includes(secret), `log contains ${secret}`);
  }
});

test("an account keeps one logId across connections, and grants carry it", async () => {
  const { db, oauth, clock, logs } = setup();
  const first = await connect(oauth);
  const { logId } = db.documents.get("accounts/alice/assistant/log");
  assert.equal((await verifyAccessToken(db, first.access_token, { now: clock.now() })).logId, logId);
  // A connection made before logIds existed: revoking it still logs the account's logId.
  db.documents.set("oauthGrants/legacy", { uid: "alice", clientId: "c", clientName: "Old", assistant: "other", scopes: [], lastUsedAt: new Date(T0) });
  const second = await connect(oauth);
  assert.equal((await verifyAccessToken(db, second.access_token, { now: clock.now() })).logId, logId, "a reconnect reuses the logId");
  assert.equal(await oauth.revokeGrant("legacy"), true);
  const revoked = logs.find((entry) => entry.assistantEvent === "connection.revoked" && entry.grantId === "legacy");
  assert.equal(revoked.logId, logId);
  assert.equal(db.documents.get("accounts/alice/assistant/log").logId, logId);
});

test("an authorization code for an account deleted since consent creates nothing", async () => {
  const { db, oauth, logs } = setup();
  const code = await approveCode(oauth);
  // Account deletion: tombstone first, then the assistant documents go.
  db.documents.set("accounts/alice", { active: false, schemaVersion: 1 });
  db.documents.delete("accounts/alice/assistant/log");
  await assert.rejects(oauth.token({
    grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: CLAUDE_ID, redirect_uri: CLAUDE_REDIRECT, resource: MCP,
  }), { error: "invalid_grant" });
  assert.deepEqual(Object.keys(db.dump()).filter((path) => path.startsWith("accounts/alice/") || path.startsWith("oauthGrants/")), []);
  assert.equal(logs.find((entry) => entry.assistantEvent === "oauth.code_exchange").outcome, "rejected");
});

test("rejected access tokens are logged with a reason only", async () => {
  const { db, oauth } = setup();
  const tokens = await connect(oauth);
  const reasons = [];
  const onReject = (reason) => reasons.push(reason);
  await verifyAccessToken(db, "nope", { now: T0, onReject });
  await verifyAccessToken(db, "aot_at_unknown", { now: T0, onReject });
  await verifyAccessToken(db, tokens.refresh_token.replace("aot_rt_", "aot_at_"), { now: T0, onReject });
  await verifyAccessToken(db, tokens.access_token, { now: T0 + 2 * 60 * 60 * 1000, onReject });
  assert.deepEqual(reasons, ["malformed", "unknown", "unknown", "expired"]);
});

test("PKCE, redirect URI, client and resource must all match the authorization", async () => {
  const { oauth } = setup();
  const code = await approveCode(oauth);
  const base = { grant_type: "authorization_code", code, client_id: CLAUDE_ID, redirect_uri: CLAUDE_REDIRECT };
  await assert.rejects(oauth.token({ ...base, code_verifier: "w".repeat(43) }), { error: "invalid_grant", message: /PKCE/ });
  await assert.rejects(oauth.token({ ...base, code_verifier: VERIFIER, redirect_uri: "https://claude.ai/other" }), { error: "invalid_grant" });
  await assert.rejects(oauth.token({ ...base, code_verifier: VERIFIER, resource: "https://evil.example/mcp" }), { error: "invalid_target" });
  await assert.rejects(oauth.token({ ...base, code_verifier: undefined }), { error: "invalid_grant" });
  // The failed attempts did not consume the code.
  assert.ok((await oauth.token({ ...base, code_verifier: VERIFIER })).access_token);
});

test("an authorization code works once; a quick retry is refused, later reuse revokes the connection", async () => {
  const { db, oauth, clock } = setup();
  const code = await approveCode(oauth);
  const request = { grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: CLAUDE_ID, redirect_uri: CLAUDE_REDIRECT };
  const tokens = await oauth.token(request);
  // Within 30 seconds: most likely a client retrying a lost response.
  clock.advance(REUSE_GRACE_MS - 1000);
  await assert.rejects(oauth.token(request), { error: "invalid_grant", message: /already used$/ });
  assert.ok(await verifyAccessToken(db, tokens.access_token, { now: clock.now() }));
  clock.advance(2000);
  await assert.rejects(oauth.token(request), { error: "invalid_grant", message: /revoked/ });
  assert.equal(await verifyAccessToken(db, tokens.access_token, { now: clock.now() }), null);
  assert.equal(db.documents.get("accounts/alice/assistant/state").connected, false);
});

test("a spent code revokes the connection only when its own client presents it with the right verifier", async () => {
  const { db, oauth, clock } = setup();
  const code = await approveCode(oauth);
  const request = { grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: CLAUDE_ID, redirect_uri: CLAUDE_REDIRECT };
  const tokens = await oauth.token(request);
  clock.advance(REUSE_GRACE_MS + 1000);
  const stranger = await registerClient(db, { redirect_uris: ["https://elsewhere.example/cb"], token_endpoint_auth_method: "none" }, { now: clock.now() });
  await assert.rejects(oauth.token({ ...request, client_id: stranger.client_id, redirect_uri: "https://elsewhere.example/cb" }),
    { error: "invalid_grant", message: /another client/ });
  await assert.rejects(oauth.token({ ...request, code_verifier: "w".repeat(43) }), { error: "invalid_grant", message: /PKCE/ });
  assert.ok(await verifyAccessToken(db, tokens.access_token, { now: clock.now() }), "the connection survives both");
  assert.equal(db.documents.get("accounts/alice/assistant/state").connected, true);
  await assert.rejects(oauth.token(request), { error: "invalid_grant", message: /revoked/ });
  assert.equal(await verifyAccessToken(db, tokens.access_token, { now: clock.now() }), null);
});

test("codes expire after ten minutes", async () => {
  const { oauth, clock } = setup();
  const code = await approveCode(oauth);
  clock.advance(10 * 60 * 1000 + 1);
  await assert.rejects(oauth.token({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: CLAUDE_ID }), { error: "invalid_grant", message: /expired/ });
});

test("refresh tokens rotate, and replaying an old one after the grace period revokes everything", async () => {
  const { db, oauth, clock, messaging } = setup();
  const first = await connect(oauth);
  db.documents.set("accounts/alice/assistantDevices/d1", { platform: "android", fcmToken: "fcm-1", deviceName: "Pixel 9", updatedAt: new Date(T0) });
  db.documents.set("accounts/alice/assistantSnapshots/d1", { payload: "{}" });
  db.documents.set("accounts/alice/assistantActivity/ch_1", { summary: "x" });
  clock.advance(60 * 60 * 1000);
  const second = await oauth.token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLAUDE_ID });
  assert.notEqual(second.refresh_token, first.refresh_token);
  assert.ok(await verifyAccessToken(db, second.access_token, { now: clock.now() }));
  // A quick retry with the old token is refused without revoking (likely a lost response).
  clock.advance(REFRESH_REUSE_GRACE_MS - 1000);
  await assert.rejects(oauth.token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLAUDE_ID }), { error: "invalid_grant" });
  assert.ok(await verifyAccessToken(db, second.access_token, { now: clock.now() }));
  // Later reuse means the token leaked: the connection ends and the connector data goes.
  clock.advance(5000);
  await assert.rejects(oauth.token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLAUDE_ID }), { message: /revoked/ });
  assert.equal(await verifyAccessToken(db, second.access_token, { now: clock.now() }), null);
  await assert.rejects(oauth.token({ grant_type: "refresh_token", refresh_token: second.refresh_token, client_id: CLAUDE_ID }), { error: "invalid_grant" });
  assert.deepEqual(db.documents.get("accounts/alice/assistant/state").connected, false);
  // The logId stays until the account is deleted, so a reconnect logs under the same one.
  assert.deepEqual(Object.keys(db.dump()).filter((path) => path.startsWith("accounts/alice/assistant")).sort(), [
    "accounts/alice/assistant/log", "accounts/alice/assistant/state",
  ]);
  assert.deepEqual(Object.keys(db.dump()).filter((path) => path.startsWith("oauthGrants/") || path.startsWith("oauthTokens/")), []);
  assert.deepEqual(messaging.sent.map((message) => [message.token, message.data.type, message.android.priority]), [["fcm-1", "state", "high"]]);
});

test("refresh tokens are bound to their client", async () => {
  const { db, oauth } = setup();
  const tokens = await connect(oauth);
  const other = await registerClient(db, { redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"], token_endpoint_auth_method: "none" }, { now: Date.now() });
  await assert.rejects(oauth.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: other.client_id }), { error: "invalid_grant" });
});

test("reconnecting the same assistant replaces its connection; another assistant adds one", async () => {
  const { db, oauth } = setup();
  const first = await connect(oauth);
  const second = await connect(oauth);
  assert.equal(await verifyAccessToken(db, first.access_token, { now: T0 }), null);
  assert.ok(await verifyAccessToken(db, second.access_token, { now: T0 }));
  assert.equal(db.documents.get("accounts/alice/assistant/state").connections, 1);
  const chatgpt = await registerClient(db, {
    client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"], token_endpoint_auth_method: "client_secret_post",
  }, { now: Date.now() });
  const code = await approveCode(oauth, { clientId: chatgpt.client_id, redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect" });
  const request = { grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: chatgpt.client_id, redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect" };
  await assert.rejects(oauth.token({ ...request, client_secret: "wrong" }), { error: "invalid_client" });
  const tokens = await oauth.token({ ...request, client_secret: chatgpt.client_secret });
  // A registered client calling itself ChatGPT is not ChatGPT: only metadata hosts are trusted.
  const impostor = await verifyAccessToken(db, tokens.access_token, { now: T0 });
  assert.deepEqual([impostor.assistant, impostor.clientName], ["other", "Unverified app"]);
  assert.equal(db.documents.get("accounts/alice/assistant/state").connections, 2);
  const listed = await oauth.listConnections("alice");
  assert.deepEqual(listed.map((c) => c.assistant).sort(), ["claude", "other"]);
  const claude = listed.find((c) => c.assistant === "claude");
  assert.deepEqual(Object.keys(claude).sort(), ["assistant", "clientHost", "clientName", "createdAt", "grantId", "lastUsedAt", "scopes", "setupConfirmedAt", "verified"]);
  assert.deepEqual([claude.clientName, claude.verified, claude.clientHost], ["Claude", true, "claude.ai"]);
  const other = listed.find((c) => c.assistant === "other");
  assert.deepEqual([other.clientName, other.verified, other.clientHost], ["Unverified app", false, "chatgpt.com"]);
  // Revoking one keeps the account connected; the app can only revoke its own connections.
  assert.equal(await oauth.revokeGrant(listed[0].grantId, { uid: "mallory" }), false);
  assert.equal(await oauth.revokeGrant(listed[0].grantId, { uid: "alice" }), true);
  assert.deepEqual([db.documents.get("accounts/alice/assistant/state").connected, db.documents.get("accounts/alice/assistant/state").connections], [true, 1]);
});

test("revocation (RFC 7009): an access token alone, or the whole connection via its refresh token", async () => {
  const { db, oauth } = setup();
  const tokens = await connect(oauth);
  await oauth.revoke({ token: tokens.access_token, client_id: CLAUDE_ID });
  assert.equal(await verifyAccessToken(db, tokens.access_token, { now: T0 }), null);
  assert.equal(db.documents.get("accounts/alice/assistant/state").connected, true);
  await oauth.revoke({ token: "aot_rt_unknown", client_id: CLAUDE_ID });
  await oauth.revoke({ token: tokens.refresh_token, client_id: CLAUDE_ID });
  assert.equal(db.documents.get("accounts/alice/assistant/state").connected, false);
  assert.deepEqual(await oauth.listConnections("alice"), []);
});

test("authorize refuses unknown clients and unregistered redirects without redirecting", async () => {
  const { oauth } = setup();
  const base = { response_type: "code", client_id: CLAUDE_ID, redirect_uri: CLAUDE_REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256" };
  assert.equal((await oauth.authorize({ ...base, client_id: "aot_client_unknown" })).page.status, 400);
  assert.equal((await oauth.authorize({ ...base, redirect_uri: "https://evil.example/callback" })).page.status, 400);
  const error = (result) => new URL(result.redirect).searchParams.get("error");
  assert.equal(error(await oauth.authorize({ ...base, code_challenge_method: "plain" })), "invalid_request");
  assert.equal(error(await oauth.authorize({ ...base, code_challenge: undefined })), "invalid_request");
  assert.equal(error(await oauth.authorize({ ...base, response_type: "token" })), "unsupported_response_type");
  assert.equal(error(await oauth.authorize({ ...base, resource: "https://evil.example/mcp" })), "invalid_target");
  // With a single registered redirect, redirect_uri may be omitted.
  assert.ok((await oauth.authorize({ ...base, redirect_uri: undefined })).redirect.includes("/connect/?request="));
});

test("a Sign in with Apple session approves like a Google one, with or without an email", async () => {
  const { db, oauth } = setup();
  db.documents.set("accounts/iphone", { active: true, schemaVersion: 1 });
  const { redirect } = await oauth.authorize({ response_type: "code", client_id: CLAUDE_ID, redirect_uri: CLAUDE_REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256" });
  const request = requestIdFrom(redirect);
  const info = await oauth.consentInfo({ request, idToken: "ap:iphone" });
  assert.deepEqual([info.account, info.email], ["ready", null]);
  // An Apple account that never turned on Account & sync is told to, without naming Google.
  await assert.rejects(oauth.decide({ request, idToken: "ap:stranger", decision: "approve" }),
    (error) => error.error === "account_not_ready" && !/Google/.test(error.message));
  // A password session on an Apple-linked account, or a token without the Apple identity, can't.
  db.documents.set("accounts/linked", { active: true, schemaVersion: 1 });
  for (const idToken of ["pwa:linked", "apx:iphone"]) {
    await assert.rejects(oauth.decide({ request, idToken, decision: "approve" }), { error: "login_required" }, idToken);
  }
  const approved = new URL((await oauth.decide({ request, idToken: "ap:iphone", decision: "approve" })).redirect);
  assert.ok(approved.searchParams.get("code"));
  assert.equal(Object.values(db.dump()).find((doc) => doc.codeChallenge === CHALLENGE).uid, "iphone");
});

test("only a Google or Apple sign-in can approve, except a password sign-in to the configured review account", async () => {
  for (const demoUid of [undefined, "", "reviewer"]) {
    const { db, oauth } = setup({ demoUid });
    for (const uid of ["reviewer", "mallory", "linked"]) db.documents.set(`accounts/${uid}`, { active: true, schemaVersion: 1 });
    const { redirect } = await oauth.authorize({ response_type: "code", client_id: CLAUDE_ID, redirect_uri: CLAUDE_REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256" });
    const request = requestIdFrom(redirect);
    // Other password accounts, anonymous accounts and password sign-ins that happen to have Google or Apple linked never can.
    for (const idToken of ["pw:mallory", "pwg:linked", "pwa:linked", "id:anon"]) {
      await assert.rejects(oauth.consentInfo({ request, idToken }), { error: "login_required" }, idToken);
      await assert.rejects(oauth.decide({ request, idToken, decision: "approve" }), { error: "login_required" }, idToken);
    }
    if (demoUid !== "reviewer") {
      await assert.rejects(oauth.decide({ request, idToken: "pw:reviewer", decision: "approve" }), { error: "login_required" });
      continue;
    }
    assert.equal((await oauth.consentInfo({ request, idToken: "pw:reviewer" })).account, "ready");
    const approved = new URL((await oauth.decide({ request, idToken: "pw:reviewer", decision: "approve" })).redirect);
    assert.ok(approved.searchParams.get("code"));
    assert.equal(Object.values(db.dump()).find((doc) => doc.codeChallenge === CHALLENGE).uid, "reviewer");
  }
});

test("the consent page learns who is asking and whether the account is ready; cancelling denies", async () => {
  const { db, oauth } = setup();
  const { redirect } = await oauth.authorize({ response_type: "code", client_id: CLAUDE_ID, redirect_uri: CLAUDE_REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "x" });
  const request = requestIdFrom(redirect);
  assert.deepEqual(await oauth.consentInfo({ request }), { clientName: "Claude", verified: true, clientHost: "claude.ai", scopes: ["alarms.read", "alarms.write"] });
  assert.equal((await oauth.consentInfo({ request, idToken: "id:alice" })).account, "ready");
  assert.equal((await oauth.consentInfo({ request, idToken: "id:bob" })).account, "not_ready");
  await assert.rejects(oauth.consentInfo({ request, idToken: "id:anon" }), { error: "login_required" });
  await assert.rejects(oauth.decide({ request, idToken: "id:bob", decision: "approve" }), { error: "account_not_ready", status: 409 });
  await assert.rejects(oauth.decide({ request, idToken: "garbage", decision: "approve" }), { error: "login_required" });
  const denied = new URL((await oauth.decide({ request, decision: "deny" })).redirect);
  assert.deepEqual([denied.searchParams.get("error"), denied.searchParams.get("state")], ["access_denied", "x"]);
  await assert.rejects(oauth.decide({ request, idToken: "id:alice", decision: "approve" }), { error: "expired" });
  assert.equal(Object.keys(db.dump()).some((path) => path.startsWith("oauthCodes/")), false);
});

test("pending authorizations expire after ten minutes", async () => {
  const { oauth, clock } = setup();
  const { redirect } = await oauth.authorize({ response_type: "code", client_id: CLAUDE_ID, code_challenge: CHALLENGE, code_challenge_method: "S256" });
  clock.advance(10 * 60 * 1000 + 1);
  await assert.rejects(oauth.decide({ request: requestIdFrom(redirect), idToken: "id:alice", decision: "approve" }), { error: "expired" });
});

test("idle connections are pruned after 90 days", async () => {
  const { db, oauth, clock } = setup();
  await connect(oauth);
  clock.advance(89 * 24 * 60 * 60 * 1000);
  assert.equal(await oauth.pruneIdleGrants(), 0);
  clock.advance(2 * 24 * 60 * 60 * 1000);
  assert.equal(await oauth.pruneIdleGrants(), 1);
  assert.equal(db.documents.get("accounts/alice/assistant/state").connected, false);
});

// ---- Clients ----------------------------------------------------------------------------------

test("client ID metadata URLs must be plain https URLs with a path on a host name", () => {
  assert.equal(parseClientIdUrl(CLAUDE_ID).hostname, "claude.ai");
  for (const bad of [
    "http://claude.ai/oauth/meta", "https://claude.ai/", "https://claude.ai", "https://user:pw@claude.ai/x",
    "https://claude.ai/x#frag", "https://127.0.0.1/x", "https://[::1]/x", "https://localhost/x", "https://claude.ai:8443/x",
    "https://claude.ai/a/../b", "https://CLAUDE.ai/x", "ftp://claude.ai/x", "not a url",
    `${CLAUDE_ID}?x=1`, `${CLAUDE_ID}?`, "https://chatgpt.com/oauth/client.json?redirect=1",
  ]) assert.throws(() => parseClientIdUrl(bad), ClientError, bad);
});

test("only public unicast addresses may be fetched", () => {
  for (const ok of ["8.8.8.8", "160.79.104.10", "2606:4700::1111"]) assert.equal(isPublicAddress(ok), true, ok);
  for (const blocked of [
    "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
    "64:ff9b::a00:1", "2002:a00:1::", "2001:db8::1", "ff02::1", "not-an-ip",
  ]) assert.equal(isPublicAddress(blocked), false, blocked);
});

test("metadata fetches refuse private DNS answers, redirects, large and non-JSON bodies", async () => {
  const publicLookup = async () => [{ address: "160.79.104.10", family: 4 }];
  const body = (status, text, headers = { "content-type": "application/json" }) => async () => ({ status, headers, body: Buffer.from(text) });
  await assert.rejects(fetchClientMetadata(CLAUDE_ID, { lookup: async () => [{ address: "10.0.0.5", family: 4 }], get: body(200, "{}") }), /not a public address/);
  await assert.rejects(fetchClientMetadata(CLAUDE_ID, { lookup: async () => [{ address: "160.79.104.10", family: 4 }, { address: "127.0.0.1", family: 4 }], get: body(200, "{}") }), /not a public address/);
  await assert.rejects(fetchClientMetadata(CLAUDE_ID, { lookup: publicLookup, get: body(302, "", { location: "http://169.254.169.254/" }) }), /HTTP 302/);
  await assert.rejects(fetchClientMetadata(CLAUDE_ID, { lookup: publicLookup, get: body(200, "x".repeat(6000)) }), /too large/);
  await assert.rejects(fetchClientMetadata(CLAUDE_ID, { lookup: publicLookup, get: body(200, "<html>", { "content-type": "text/html" }) }), /not JSON/);
  let pinned;
  await assert.rejects(fetchClientMetadata(CLAUDE_ID, { lookup: publicLookup, get: body(200, '{"a":1}', {}) }), /not JSON/, "a JSON content type is required");
  const doc = await fetchClientMetadata(CLAUDE_ID, { lookup: publicLookup, get: async (url, address) => {
    pinned = address;
    return { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: Buffer.from('{"a":1}') };
  } });
  assert.deepEqual(doc, { a: 1 });
  assert.deepEqual(pinned, { address: "160.79.104.10", family: 4 }, "the request connects to the checked address");
});

test("the real fetch only speaks TLS, so a plain-HTTP endpoint fails closed", async () => {
  const { httpsGet } = require("../assistant-oauth-clients");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("x".repeat(10_000));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = new URL(`http://127.0.0.1:${server.address().port}/meta`);
    await assert.rejects(httpsGet(url, { address: "127.0.0.1", family: 4 }, { maxBytes: 100, timeoutMs: 2000 }));
  } finally {
    server.close();
  }
});

test("metadata documents must name themselves and list valid redirects; they are cached", async () => {
  assert.throws(() => validateClientMetadata({ client_id: "https://other.example/x", redirect_uris: [CLAUDE_REDIRECT] }, { kind: "cimd", clientId: CLAUDE_ID }), /own URL/);
  assert.throws(() => validateClientMetadata({ client_id: CLAUDE_ID, redirect_uris: ["http://claude.ai/cb"] }, { kind: "cimd", clientId: CLAUDE_ID }), ClientError);
  assert.throws(() => validateClientMetadata({ client_id: CLAUDE_ID, redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: "client_secret_post" }, { kind: "cimd", clientId: CLAUDE_ID }), /token_endpoint_auth_method/);
  const { db, fetches } = setup();
  const now = Date.now();
  const fetchMetadata = async (url) => {
    fetches.push(url);
    return { client_id: CLAUDE_ID, client_name: "Claude <script>", redirect_uris: [CLAUDE_REDIRECT] };
  };
  const client = await getClient(db, CLAUDE_ID, { now, fetchMetadata, fetch: true });
  assert.deepEqual([client.clientName, client.declaredName, client.verified], ["Claude", "Claude script", true]);
  await getClient(db, CLAUDE_ID, { now: now + 60_000, fetchMetadata, fetch: true });
  assert.equal(fetches.length, 1, "fresh documents come from the cache");
  // An unreachable document falls back to a cached copy for a while.
  const failing = async () => { throw new ClientError("invalid_client", "down"); };
  assert.equal((await getClient(db, CLAUDE_ID, { now: now + 2 * 86400000, fetchMetadata: failing, fetch: true })).clientName, "Claude");
  await assert.rejects(getClient(db, CLAUDE_ID, { now: now + 8 * 86400000, fetchMetadata: failing, fetch: true }), ClientError);
});

// The documents Claude, Claude Code and ChatGPT served on 2026-10-17.
const LIVE_DOCUMENTS = {
  claude: {
    client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata", client_name: "Claude", client_uri: "https://claude.ai",
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"], response_types: ["code"], token_endpoint_auth_method: "none",
  },
  claudeCode: {
    client_id: "https://claude.ai/oauth/claude-code-client-metadata", client_name: "Claude Code", client_uri: "https://claude.ai",
    redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    token_endpoint_auth_method: "none",
  },
  chatgpt: {
    client_id: "https://chatgpt.com/oauth/client.json", client_uri: "https://chatgpt.com/", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: ["none", "private_key_jwt"], grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"], client_name: "ChatGPT", token_endpoint_auth_signing_alg: "RS256", jwks_uri: "https://chatgpt.com/oauth/jwks.json",
  },
  chatgptCallback: {
    client_id: "https://chatgpt.com/oauth/test123/client.json", client_uri: "https://chatgpt.com/", redirect_uris: ["https://chatgpt.com/connector/oauth/test123"],
    token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: ["none", "private_key_jwt"], grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"], client_name: "ChatGPT",
  },
};

test("the real Claude, Claude Code and ChatGPT metadata documents are accepted and named", () => {
  const check = (doc) => validateClientMetadata(doc, { kind: "cimd", clientId: doc.client_id });
  const claude = check(LIVE_DOCUMENTS.claude);
  assert.deepEqual([claude.clientName, claude.assistant, claude.verified, claude.tokenEndpointAuthMethod], ["Claude", "claude", true, "none"]);
  assert.deepEqual(claude.grantTypes, ["authorization_code", "refresh_token"], "grants this server doesn't offer are left out");
  const code = check(LIVE_DOCUMENTS.claudeCode);
  assert.deepEqual([code.clientName, code.assistant, code.verified], ["Claude Code", "claude", true]);
  for (const doc of [LIVE_DOCUMENTS.chatgpt, LIVE_DOCUMENTS.chatgptCallback]) {
    const chatgpt = check(doc);
    assert.deepEqual([chatgpt.clientName, chatgpt.assistant, chatgpt.verified, chatgpt.tokenEndpointAuthMethod], ["ChatGPT", "chatgpt", true, "none"]);
  }
  // A document that supports only signed assertions still can't be used.
  assert.throws(() => check({ ...LIVE_DOCUMENTS.chatgpt, token_endpoint_auth_methods_supported: ["private_key_jwt"] }), /token_endpoint_auth_method/);
  // Dynamic registration stays strict about grants.
  assert.throws(() => validateClientMetadata({ redirect_uris: ["https://a.example/cb"], grant_types: LIVE_DOCUMENTS.claude.grant_types }, { kind: "dcr", clientId: "aot_client_x" }), /grant_types/);
});

test("only the exact known metadata URLs carry a brand", () => {
  const { brandOf } = require("../assistant-oauth-clients");
  const name = (clientId) => brandOf("cimd", clientId)?.name ?? null;
  assert.equal(name("https://claude.ai/oauth/mcp-oauth-client-metadata"), "Claude");
  assert.equal(name("https://claude.ai/oauth/claude-code-client-metadata"), "Claude Code");
  assert.equal(name("https://chatgpt.com/oauth/client.json"), "ChatGPT");
  assert.equal(name("https://chatgpt.com/oauth/Ab_9-x/client.json"), "ChatGPT");
  for (const other of [
    "https://claude.ai/oauth/other", "https://claude.ai/api/mcp/auth_callback", "https://claude.ai/oauth/mcp-oauth-client-metadata/",
    "https://claude.ai/oauth/mcp-oauth-client-metadata?x=1", "https://chatgpt.com/oauth/client.json?x=1", "https://chatgpt.com/oauth/a/b/client.json",
    "https://chatgpt.com/files/client.json", "https://chatgpt.com/oauth//client.json", "https://www.chatgpt.com/oauth/client.json",
    "https://claude.ai.example/oauth/mcp-oauth-client-metadata", "https://chatgpt.com:8443/oauth/client.json",
  ]) assert.equal(name(other), null, other);
  assert.equal(brandOf("dcr", "https://claude.ai/oauth/mcp-oauth-client-metadata"), null);
  // Any other document on the brand's host is an unverified app.
  const other = validateClientMetadata({ client_id: "https://claude.ai/oauth/other", client_name: "Claude", redirect_uris: ["https://evil.example/cb"] },
    { kind: "cimd", clientId: "https://claude.ai/oauth/other" });
  assert.deepEqual([other.clientName, other.verified, other.assistant], ["Unverified app", false, "other"]);
});

test("a branded client's redirect URIs must stay on its host, or on loopback for Claude Code", () => {
  const check = (doc, redirect_uris) => validateClientMetadata({ ...doc, redirect_uris }, { kind: "cimd", clientId: doc.client_id });
  for (const uris of [["https://evil.example/cb"], [CLAUDE_REDIRECT, "https://evil.example/cb"], ["https://sub.claude.ai/cb"],
    ["https://claude.ai:8443/cb"], ["http://localhost/callback"]]) {
    assert.throws(() => check(LIVE_DOCUMENTS.claude, uris), { error: "invalid_redirect_uri" }, uris.join());
  }
  assert.throws(() => check(LIVE_DOCUMENTS.chatgpt, [CLAUDE_REDIRECT]), { error: "invalid_redirect_uri" });
  assert.throws(() => check(LIVE_DOCUMENTS.claudeCode, ["https://claude.ai/api/mcp/auth_callback"]), { error: "invalid_redirect_uri" });
  assert.throws(() => check(LIVE_DOCUMENTS.claudeCode, ["http://localhost/callback", "https://evil.example/cb"]), { error: "invalid_redirect_uri" });
  assert.equal(check(LIVE_DOCUMENTS.claudeCode, ["http://[::1]/callback"]).verified, true);
});

test("ChatGPT connects through its metadata document as a public client", async () => {
  const { db, oauth } = setup({ metadata: LIVE_DOCUMENTS.chatgpt });
  const redirectUri = LIVE_DOCUMENTS.chatgpt.redirect_uris[0];
  const tokens = await connect(oauth, { clientId: LIVE_DOCUMENTS.chatgpt.client_id, redirectUri });
  const grant = await verifyAccessToken(db, tokens.access_token, { now: T0 });
  assert.deepEqual([grant.clientName, grant.assistant], ["ChatGPT", "chatgpt"]);
});

test("Claude Code connects through its metadata document on any loopback port", async () => {
  const { db, oauth } = setup({ metadata: LIVE_DOCUMENTS.claudeCode });
  const tokens = await connect(oauth, { clientId: LIVE_DOCUMENTS.claudeCode.client_id, redirectUri: "http://localhost:3118/callback" });
  const grant = await verifyAccessToken(db, tokens.access_token, { now: T0 });
  assert.deepEqual([grant.clientName, grant.assistant], ["Claude Code", "claude"]);
});

test("redirect URIs: https anywhere, http only on loopback where any port matches", () => {
  assert.equal(isValidRedirectUri("https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(isValidRedirectUri("http://localhost:6274/oauth/callback"), true);
  assert.equal(isValidRedirectUri("http://example.com/cb"), false);
  assert.equal(isValidRedirectUri("https://claude.ai/cb#x"), false);
  assert.equal(isValidRedirectUri("javascript:alert(1)"), false);
  assert.equal(redirectMatches("https://claude.ai/cb", "https://claude.ai/cb"), true);
  assert.equal(redirectMatches("https://claude.ai/cb", "https://claude.ai/cb/"), false);
  assert.equal(redirectMatches("https://claude.ai/cb", "https://claude.ai.evil.com/cb"), false);
  assert.equal(redirectMatches("http://127.0.0.1:1234/cb", "http://127.0.0.1:5555/cb"), true);
  assert.equal(redirectMatches("http://127.0.0.1:1234/cb", "http://127.0.0.1:5555/other"), false);
  assert.equal(redirectMatches("http://localhost/cb", "http://127.0.0.1/cb"), false);
});

test("dynamic registration validates metadata and returns a secret only to confidential clients", async () => {
  const db = new FakeFirestore();
  const publicClient = await registerClient(db, { client_name: "Inspector", redirect_uris: ["http://localhost:6274/oauth/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }, { now: Date.now() });
  assert.match(publicClient.client_id, /^aot_client_/);
  assert.equal(publicClient.client_secret, undefined);
  const confidential = await registerClient(db, { redirect_uris: ["https://chatgpt.com/cb"] }, { now: Date.now() });
  assert.equal(confidential.token_endpoint_auth_method, "client_secret_basic");
  assert.match(confidential.client_secret, /^aot_secret_/);
  assert.equal(JSON.stringify(db.dump()).includes(confidential.client_secret), false);
  for (const bad of [{}, { redirect_uris: [] }, { redirect_uris: ["http://evil.example/cb"] }, { redirect_uris: ["https://a.example/cb"], grant_types: ["implicit"] },
    { redirect_uris: ["https://a.example/cb"], response_types: ["token"] }, { redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "private_key_jwt" },
    { redirect_uris: Array(11).fill("https://a.example/cb") }]) {
    await assert.rejects(registerClient(db, bad, { now: Date.now() }), ClientError, JSON.stringify(bad));
  }
});

// ---- HTTP -------------------------------------------------------------------------------------

async function withServer(handler, run) {
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const type = req.headers["content-type"] ?? "";
    req.body = type.includes("json") ? JSON.parse(text || "{}") : Object.fromEntries(new URLSearchParams(text));
    await handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test("HTTP routes serve discovery, register, authorize, token and revoke with OAuth error bodies", async () => {
  const { db, oauth } = setup();
  const handler = createOAuthHandler({ oauth, db, now: () => Date.now() });
  await withServer(handler, async (base) => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.equal((await response.json()).resource, MCP);
    }
    assert.equal((await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()).issuer, ORIGIN);
    assert.equal((await fetch(`${base}/oauth/nowhere`)).status, 404);
    assert.equal((await fetch(`${base}/oauth/token`)).status, 405);
    assert.equal((await fetch(`${base}/oauth/token`, { method: "OPTIONS" })).status, 204);

    const registered = await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Inspector", redirect_uris: ["http://localhost:6274/oauth/callback"], token_endpoint_auth_method: "none" }) });
    assert.equal(registered.status, 201);
    const { client_id: clientId } = await registered.json();
    const badRegistration = await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal((await badRegistration.json()).error, "invalid_redirect_uri");

    const authorize = await fetch(`${base}/oauth/authorize?${new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: "http://localhost:6274/oauth/callback", code_challenge: CHALLENGE, code_challenge_method: "S256", state: "abc",
    })}`, { redirect: "manual" });
    assert.equal(authorize.status, 302);
    const request = requestIdFrom(authorize.headers.get("location"));
    const unknown = await fetch(`${base}/oauth/authorize?client_id=nope`, { redirect: "manual" });
    assert.equal(unknown.status, 400);
    assert.match(unknown.headers.get("content-type"), /text\/html/);
    assert.equal(unknown.headers.get("x-frame-options"), "DENY");

    const info = await (await fetch(`${base}/oauth/consent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request, idToken: "id:alice" }) })).json();
    assert.deepEqual([info.clientName, info.verified, info.clientHost, info.account], ["Unverified app", false, "localhost:6274", "ready"]);
    const approved = await (await fetch(`${base}/oauth/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request, idToken: "id:alice", decision: "approve" }) })).json();
    const code = new URL(approved.redirect).searchParams.get("code");

    const form = (fields) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
    const tokenResponse = await fetch(`${base}/oauth/token`, form({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: clientId, redirect_uri: "http://localhost:6274/oauth/callback" }));
    assert.equal(tokenResponse.status, 200);
    assert.equal(tokenResponse.headers.get("cache-control"), "no-store");
    const tokens = await tokenResponse.json();
    const again = await fetch(`${base}/oauth/token`, form({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: clientId }));
    assert.deepEqual([again.status, (await again.json()).error], [400, "invalid_grant"]);
    const unsupported = await fetch(`${base}/oauth/token`, form({ grant_type: "password", client_id: clientId }));
    assert.equal((await unsupported.json()).error, "unsupported_grant_type");
    const badClient = await fetch(`${base}/oauth/token`, form({ grant_type: "refresh_token", client_id: "aot_client_x", refresh_token: `aot_rt_${"x".repeat(43)}` }));
    assert.deepEqual([badClient.status, (await badClient.json()).error], [401, "invalid_client"]);
    const revoked = await fetch(`${base}/oauth/revoke`, form({ token: tokens.refresh_token, client_id: clientId }));
    assert.equal(revoked.status, 200);
    assert.equal(await verifyAccessToken(db, tokens.access_token, { now: T0 }), null);
  });
});

test("per-IP limits stop registration floods", async () => {
  const { db, oauth } = setup();
  const handler = createOAuthHandler({ oauth, db, now: () => Date.parse("2026-10-16T12:00:00Z") });
  await withServer(handler, async (base) => {
    const register = () => fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json", "fastly-client-ip": "203.0.113.9" },
      body: JSON.stringify({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "none" }) });
    const statuses = [];
    for (let i = 0; i < 31; i += 1) statuses.push((await register()).status);
    assert.equal(statuses.filter((status) => status === 201).length, 30);
    assert.equal(statuses.at(-1), 429);
  });
});

test("OAuthError keeps the OAuth error code and HTTP status", () => {
  const error = new OAuthError("invalid_grant", "nope");
  assert.deepEqual([error.error, error.status, error.message], ["invalid_grant", 400, "nope"]);
});

// ---- Verification, redirects and abuse limits ---------------------------------------------------

test("only allowlisted metadata hosts get a brand; anything else is an unverified app with its host shown", async () => {
  const evilId = "https://evil.example/claude-metadata";
  const evilRedirect = "https://evil.example/callback";
  const { db, oauth } = setup({ metadata: { client_id: evilId, client_name: "Claude‮", redirect_uris: [evilRedirect] } });
  const { redirect } = await oauth.authorize({ response_type: "code", client_id: evilId, redirect_uri: evilRedirect, code_challenge: CHALLENGE, code_challenge_method: "S256" });
  const info = await oauth.consentInfo({ request: requestIdFrom(redirect) });
  assert.deepEqual([info.clientName, info.verified, info.clientHost], ["Unverified app", false, "evil.example"]);
  assert.equal(db.documents.get(`oauthClients/${createHash("sha256").update(evilId).digest("hex")}`).assistant, "other");
});

test("unverified clients never get an error or cancel redirect; they see a page instead", async () => {
  const { db, oauth } = setup();
  const client = await registerClient(db, { redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }, { now: T0 });
  const base = { response_type: "code", client_id: client.client_id, redirect_uri: "https://evil.example/cb", code_challenge: CHALLENGE, code_challenge_method: "S256", state: "s" };
  const refused = await oauth.authorize({ ...base, response_type: "token" });
  assert.equal(refused.redirect, undefined);
  assert.equal(refused.page.status, 400);
  const { redirect } = await oauth.authorize(base);
  assert.deepEqual(await oauth.decide({ request: requestIdFrom(redirect), decision: "deny" }), { cancelled: true });
  // A verified assistant still gets the standard error redirect.
  const verified = await oauth.authorize({ ...base, client_id: CLAUDE_ID, redirect_uri: CLAUDE_REDIRECT, response_type: "token" });
  assert.equal(new URL(verified.redirect).searchParams.get("error"), "unsupported_response_type");
});

test("the token and revocation endpoints never fetch client metadata", async () => {
  const { oauth, fetches } = setup();
  const otherId = "https://claude.ai/oauth/never-seen";
  await assert.rejects(oauth.token({ grant_type: "refresh_token", refresh_token: "aot_rt_x", client_id: otherId }), { error: "invalid_client" });
  await assert.rejects(oauth.revoke({ token: "aot_rt_x", client_id: otherId }), { error: "invalid_client" });
  assert.deepEqual(fetches, []);
  // A stored client works there without a refetch, however old its copy.
  const tokens = await connect(oauth);
  assert.equal(fetches.length, 1);
  assert.ok((await oauth.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: CLAUDE_ID })).access_token);
  assert.equal(fetches.length, 1);
});

test("failed metadata fetches are remembered for ten minutes, and fetches are capped per host", async () => {
  const db = new FakeFirestore();
  const id = "https://down.example/meta";
  let calls = 0;
  const failing = async () => { calls += 1; throw new ClientError("invalid_client", "down"); };
  await assert.rejects(getClient(db, id, { now: T0, fetchMetadata: failing, fetch: true }), ClientError);
  await assert.rejects(getClient(db, id, { now: T0 + 60_000, fetchMetadata: failing, fetch: true }), /recently/);
  assert.equal(calls, 1);
  await assert.rejects(getClient(db, id, { now: T0 + 11 * 60_000, fetchMetadata: failing, fetch: true }), ClientError);
  assert.equal(calls, 2);
  const { createInstanceLimiters } = require("../assistant-limits");
  const limiters = createInstanceLimiters();
  let served = 0;
  const ok = async (url) => { served += 1; return { client_id: url, redirect_uris: ["https://many.example/cb"] }; };
  for (let i = 0; i < 25; i += 1) {
    await getClient(db, `https://many.example/c${i}`, { now: T0, fetchMetadata: ok, fetch: true, limiters }).catch(() => {});
  }
  assert.equal(served, 20);
});

test("a revocation leaves connector data alone if an assistant connected again meanwhile", async () => {
  const { db, oauth } = setup();
  const tokens = await connect(oauth);
  db.documents.set("accounts/alice/assistantSnapshots/d1", { payload: "{}" });
  // Another connection lands between the revocation's transaction and its cleanup.
  const original = db.collection.bind(db);
  let raced = false;
  db.collection = (name) => {
    if (name === "oauthTokens" && !raced && db.documents.get("accounts/alice/assistant/state")?.connected === false) {
      raced = true;
      db.documents.set("accounts/alice/assistant/state", { connected: true, connections: 1 });
    }
    return original(name);
  };
  await oauth.revoke({ token: tokens.refresh_token, client_id: CLAUDE_ID });
  assert.ok(raced);
  assert.ok(db.documents.has("accounts/alice/assistantSnapshots/d1"));
});

test("a direct caller can't escape its hop, whatever client address it claims", async () => {
  const { db, oauth } = setup();
  const { createInstanceLimiters, createMemoryLimiter } = require("../assistant-limits");
  const limiters = { ...createInstanceLimiters(), hop: createMemoryLimiter({ limit: 150, windowMs: 10 * 60 * 1000 }) };
  const handler = createOAuthHandler({ oauth, db, now: () => T0, limiters });
  await withServer(handler, async (base) => {
    const token = (headers) => fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: "aot_client_x", refresh_token: "x" }).toString() });
    // Forging Fastly-Client-IP and X-Forwarded-Host doesn't make a direct call look like Hosting
    // traffic: the unforgeable hop (the last X-Forwarded-For entry) is its key and caps it.
    const forged = [];
    for (let i = 0; i < 160; i += 1) {
      forged.push((await token({ "fastly-client-ip": `203.0.113.${i}`, "x-forwarded-host": "alwaysontime.zombit.io", "x-forwarded-for": "1.2.3.4, 192.0.2.50" })).status);
    }
    assert.equal(forged.filter((status) => status === 429).length, 10);
  });
});

test("the custom domain is the only public origin; the default Hosting domains are legacy", () => {
  assert.equal(PRODUCTION_ORIGIN, ORIGIN);
  assert.deepEqual(LEGACY_HOSTS, ["always-on-time-zombit-2026.web.app", "always-on-time-zombit-2026.firebaseapp.com"]);
  const req = (host, url = "/oauth/authorize?client_id=x") => ({ url, headers: host === undefined ? {} : { "x-forwarded-host": host } });
  assert.equal(movedUrl(req("always-on-time-zombit-2026.web.app"), ORIGIN, LEGACY_HOSTS), `${ORIGIN}/oauth/authorize?client_id=x`);
  assert.equal(movedUrl(req("Always-On-Time-Zombit-2026.firebaseapp.com:443"), ORIGIN, LEGACY_HOSTS), `${ORIGIN}/oauth/authorize?client_id=x`);
  assert.equal(movedUrl(req("always-on-time-zombit-2026.web.app, proxy.example"), ORIGIN, LEGACY_HOSTS), `${ORIGIN}/oauth/authorize?client_id=x`);
  // A path is appended, never resolved, so it can't leave the origin.
  assert.equal(movedUrl(req("always-on-time-zombit-2026.web.app", "//evil.example/x"), ORIGIN, LEGACY_HOSTS), `${ORIGIN}//evil.example/x`);
  assert.equal(movedUrl({ originalUrl: "/oauth/token", url: "/token", headers: { "x-forwarded-host": LEGACY_HOSTS[0] } }, ORIGIN, LEGACY_HOSTS), `${ORIGIN}/oauth/token`);
  // The canonical host, a missing header (a direct function URL) or any other host stays put.
  for (const host of ["alwaysontime.zombit.io", undefined, "", "127.0.0.1:5012", "example.com"]) assert.equal(movedUrl(req(host), ORIGIN, LEGACY_HOSTS), null, host);
  // Without legacy hosts (the emulators), nothing moves.
  assert.equal(movedUrl(req(LEGACY_HOSTS[0]), ORIGIN), null);
});

test("OAuth and discovery requests on a legacy host get a 308 to the custom domain", async () => {
  const { db, oauth, logs } = setup();
  const logger = Object.fromEntries(["info", "warn", "error"].map((level) => [level, (message, fields) => logs.push({ level, message, ...fields })]));
  const handler = createOAuthHandler({ oauth, db, logger, now: () => T0, legacyHosts: LEGACY_HOSTS });
  await withServer(handler, async (base) => {
    const legacy = { "x-forwarded-host": "always-on-time-zombit-2026.web.app" };
    const discovery = await fetch(`${base}/.well-known/oauth-authorization-server`, { headers: legacy, redirect: "manual" });
    assert.equal(discovery.status, 308);
    assert.equal(discovery.headers.get("location"), `${ORIGIN}/.well-known/oauth-authorization-server`);
    assert.equal(discovery.headers.get("access-control-allow-origin"), "*");
    const token = await fetch(`${base}/oauth/token?x=1`, { method: "POST", headers: { ...legacy, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token", redirect: "manual" });
    assert.deepEqual([token.status, token.headers.get("location")], [308, `${ORIGIN}/oauth/token?x=1`]);
    // Preflights still succeed so browser clients can follow the redirect.
    assert.equal((await fetch(`${base}/oauth/token`, { method: "OPTIONS", headers: legacy })).status, 204);
    // Nothing was registered or rate counted for the moved requests.
    assert.equal([...db.documents.keys()].filter((key) => !key.startsWith("accounts/")).length, 0);
    // The canonical host is served as usual.
    const served = await fetch(`${base}/.well-known/oauth-authorization-server`, { headers: { "x-forwarded-host": "alwaysontime.zombit.io" } });
    assert.equal((await served.json()).issuer, ORIGIN);
  });
  const moved = logs.filter((entry) => entry.assistantEvent === "host.moved");
  assert.deepEqual(moved.map(({ path, status }) => [path, status]), [["/.well-known/oauth-authorization-server", 308], ["/oauth/token", 308]]);
});

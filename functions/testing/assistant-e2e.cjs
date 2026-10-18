// End to end through the Hosting rewrites, Functions, Auth and Firestore emulators:
//   firebase emulators:exec --only auth,firestore,functions,hosting 'node functions/testing/assistant-e2e.cjs'
// Connects an MCP client with OAuth (registration, PKCE, consent, token), uses tools, rotates the
// refresh token and disconnects. The emulators cannot deliver FCM, so the "phone" is simulated by
// writing its documents directly.
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8180';
require('firebase-admin/app').initializeApp({ projectId: 'demo-account-sync' });
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const db = getFirestore();
const site = 'http://127.0.0.1:5012';
const json = { 'Content-Type': 'application/json' };

(async () => {
  // Discovery and App Links files are served through Hosting.
  const resource = await fetch(`${site}/.well-known/oauth-protected-resource/mcp`).then(r => r.json());
  assert.equal(resource.resource, 'https://alwaysontime.zombit.io/mcp');
  assert.equal((await fetch(`${site}/.well-known/oauth-authorization-server`).then(r => r.json())).code_challenge_methods_supported[0], 'S256');
  const links = await fetch(`${site}/.well-known/assetlinks.json`);
  assert.match(links.headers.get('content-type'), /application\/json/);
  assert.equal((await links.json())[0].target.package_name, 'com.zombitstudios.alwaysontime');
  const open = await fetch(`${site}/open/event/e_${'a'.repeat(64)}`);
  assert.equal(open.status, 200);
  assert.match(await open.text(), /Open Always On Time/);
  // The home page and privacy policy live on zombit.io; the account pages stay here.
  for (const [path, location] of [['/', 'https://zombit.io/always-on-time/'], ['/privacy-policy.html', 'https://zombit.io/always-on-time/privacy/']]) {
    const moved = await fetch(`${site}${path}`, { redirect: 'manual' });
    assert.deepEqual([moved.status, moved.headers.get('location')], [301, location]);
  }
  const deletePage = await fetch(`${site}/delete-account/`);
  assert.match(await deletePage.text(), /https:\/\/zombit\.io\/always-on-time\/privacy\//);
  // The deletion page cannot be framed (clickjacking).
  assert.equal(deletePage.headers.get('x-frame-options'), 'DENY');
  assert.match(deletePage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const consentPage = await fetch(`${site}/connect/`);
  assert.match(consentPage.headers.get('content-security-policy'), /script-src 'self' https:\/\/www\.gstatic\.com/);
  assert.match(consentPage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const unauthorized = await fetch(`${site}/mcp`, { method: 'POST', headers: { ...json, Accept: 'application/json, text/event-stream' }, body: '{}' });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get('www-authenticate'), /resource_metadata=/);

  // A signed-in Google account with account sync set up.
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const subject = randomUUID();
  const fakeGoogle = `${encode({ alg: 'none' })}.${encode({ sub: subject, email: `${subject}@example.test`, email_verified: true, iss: 'https://accounts.google.com', aud: 'test' })}.`;
  const signIn = await fetch('http://127.0.0.1:9199/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=test', {
    method: 'POST', headers: json, body: JSON.stringify({ requestUri: 'http://localhost', postBody: `id_token=${fakeGoogle}&providerId=google.com`, returnSecureToken: true })
  }).then(r => r.json());
  assert.ok(signIn.idToken, JSON.stringify(signIn));
  const uid = signIn.localId;
  await db.doc(`accounts/${uid}`).set({ active: true, schemaVersion: 1 });

  // OAuth: dynamic registration, authorize with PKCE, consent, token.
  const redirectUri = 'http://localhost:6274/oauth/callback';
  const client = await fetch(`${site}/oauth/register`, { method: 'POST', headers: json,
    body: JSON.stringify({ client_name: 'MCP Inspector', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] }) }).then(r => r.json());
  const verifier = 'e2e-verifier-' + 'x'.repeat(40);
  const authorize = await fetch(`${site}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'st', resource: resource.resource })}`, { redirect: 'manual' });
  assert.equal(authorize.status, 302);
  const request = new URL(authorize.headers.get('location')).searchParams.get('request');
  const consent = await fetch(`${site}/oauth/consent`, { method: 'POST', headers: json, body: JSON.stringify({ request, idToken: signIn.idToken }) }).then(r => r.json());
  // Self-registered clients are never named after what they claim to be.
  assert.deepEqual([consent.clientName, consent.verified, consent.clientHost, consent.account], ['Unverified app', false, 'localhost:6274', 'ready']);
  const { redirect } = await fetch(`${site}/oauth/approve`, { method: 'POST', headers: json, body: JSON.stringify({ request, idToken: signIn.idToken, decision: 'approve' }) }).then(r => r.json());
  const code = new URL(redirect).searchParams.get('code');
  const form = fields => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  const tokens = await fetch(`${site}/oauth/token`, form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirectUri })).then(r => r.json());
  assert.ok(tokens.access_token, JSON.stringify(tokens));
  assert.equal((await db.doc(`accounts/${uid}/assistant/state`).get()).data().connected, true);

  // The phone sees the flag, registers and publishes a snapshot.
  const device = randomUUID();
  await db.doc(`accounts/${uid}/assistantDevices/${device}`).set({ platform: 'android', deviceName: 'Pixel 9', appVersion: '5.2.0', fcmToken: 'emulator', capabilities: ['pause'], updatedAt: Timestamp.now() });
  const start = Date.now() + 3 * 3600000;
  await db.doc(`accounts/${uid}/assistantSnapshots/${device}`).set({ schemaVersion: 1, publishedAt: Timestamp.now(), payload: JSON.stringify({
    device: 'Pixel 9', timeZone: 'America/Los_Angeles', valuesAppliedThrough: 0, windowEnd: Date.now() + 30 * 86400000, paused: { until: 0 },
    calendars: [{ key: `c_${'b'.repeat(64)}`, name: 'Work', accountType: 'com.google', watched: true }],
    events: [{ eventKey: `e_${'c'.repeat(64)}`, seriesKey: `s_${'d'.repeat(64)}`, calendarKey: `c_${'b'.repeat(64)}`, title: 'Planning', start, end: start + 3600000, recurring: false,
      alarms: [{ at: start - 600000, kind: 'lead', minutes: 10, source: 'app', status: 'on' }] }],
  }) });

  // MCP over Hosting.
  let id = 0;
  const rpc = async (token, method, params) => {
    const response = await fetch(`${site}/mcp`, { method: 'POST', headers: { ...json, Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).result;
  };
  const init = await rpc(tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  assert.match(init.instructions, /test_connection/);
  assert.equal((await rpc(tokens.access_token, 'tools/list')).tools.length, 18);
  const status = await rpc(tokens.access_token, 'tools/call', { name: 'get_status', arguments: {} });
  assert.match(status.content[0].text, /Phone: Pixel 9/);
  const upcoming = await rpc(tokens.access_token, 'tools/call', { name: 'list_upcoming_alarms', arguments: {} });
  assert.match(upcoming.content[0].text, /"Planning", 10 min before/);
  const changed = await rpc(tokens.access_token, 'tools/call', { name: 'set_event_alarms', arguments: { event: `e_${'c'.repeat(12)}`, leadTimes: [15] } });
  assert.equal(changed.isError, undefined, changed.content[0].text);
  assert.equal((await db.doc(`accounts/${uid}/values/e_${'c'.repeat(64)}`).get()).data().payload, '{"leadTimes":[15],"enabled":true}');
  const activity = (await db.doc(`accounts/${uid}/assistantActivity/${changed.structuredContent.changeId}`).get()).data();
  const value = await db.doc(`accounts/${uid}/values/e_${'c'.repeat(64)}`).get();
  assert.ok(activity.writtenAt.isEqual(value.data().updatedAt), 'writtenAt equals the values updatedAt');

  // Refresh rotates; the old access token keeps working until it expires.
  const rotated = await fetch(`${site}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).then(r => r.json());
  assert.ok(rotated.access_token);
  // The app lists and revokes the connection through its callables.
  const call = (name, data) => fetch(`http://127.0.0.1:5011/demo-account-sync/us-central1/${name}`, { method: 'POST', headers: { ...json, Authorization: `Bearer ${signIn.idToken}` }, body: JSON.stringify({ data }) }).then(r => r.json());
  const listed = await call('listAssistantConnections', {});
  const { clientName, verified, clientHost, assistant } = listed.result.connections[0];
  assert.deepEqual({ clientName, verified, clientHost, assistant }, { clientName: 'Unverified app', verified: false, clientHost: 'localhost:6274', assistant: 'other' });
  const undone = await call('undoAssistantChange', { changeId: changed.structuredContent.changeId });
  assert.equal(undone.result.undone, true, JSON.stringify(undone));
  assert.equal((await db.doc(`accounts/${uid}/values/e_${'c'.repeat(64)}`).get()).data().payload, 'null');
  assert.ok((await db.doc(`accounts/${uid}/assistantActivity/${changed.structuredContent.changeId}`).get()).data().undoneAt);
  assert.equal((await call('revokeAssistantConnection', { grantId: listed.result.connections[0].grantId })).result.revoked, true);
  assert.equal((await db.doc(`accounts/${uid}/assistant/state`).get()).data().connected, false);
  assert.equal((await db.collection(`accounts/${uid}/assistantSnapshots`).get()).size, 0);
  const after = await fetch(`${site}/mcp`, { method: 'POST', headers: { ...json, Accept: 'application/json, text/event-stream', Authorization: `Bearer ${rotated.access_token}` }, body: '{}' });
  assert.equal(after.status, 401);
  console.log('PASS: assistant connector OAuth, MCP tools, app callables and disconnect work end to end through Hosting.');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });

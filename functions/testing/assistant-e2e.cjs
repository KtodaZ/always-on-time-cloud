// End to end through the Hosting rewrites, Functions, Auth and Firestore emulators:
//   firebase emulators:exec --only auth,firestore,functions,hosting 'node functions/testing/assistant-e2e.cjs'
// Connects an MCP client with OAuth (registration, PKCE, consent, token), uses tools, rotates the
// refresh token and disconnects. The emulators cannot deliver FCM or APNs, so the Android "phone" is
// simulated by writing its documents directly, and the iPhone's notification service extension by
// reading the APNs pushes the emulator records in emulatorApnsPushes and calling assistantDeviceApi.
// Then the review account: seeded by scripts/seed-review-account.js, signed in with a password,
// and served by the server's stand-in phone (its uid is ASSISTANT_DEMO_UID in functions/.env.local).
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
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

  // An iPhone registers for APNs with the hash of its device key.
  const iphone = randomUUID().toUpperCase();
  const deviceKey = randomBytes(32).toString('base64url');
  const apnsToken = randomBytes(32).toString('hex');
  await db.doc(`accounts/${uid}/assistantDevices/${iphone}`).set({
    platform: 'ios', deviceName: 'iPhone 17', appVersion: '1.4.0', apnsToken, apnsEnvironment: 'development',
    deviceKeyHash: createHash('sha256').update(deviceKey).digest('hex'), capabilities: ['pause'], updatedAt: Timestamp.now(),
  });
  const deviceApi = (method, path, body, key = deviceKey) => fetch(`http://127.0.0.1:5011/demo-account-sync/us-central1/assistantDeviceApi${path}`, {
    method, headers: { ...json, Authorization: `Bearer ${key}` }, body: JSON.stringify({ uid, deviceId: iphone, ...body }),
  });
  const pushesTo = async type => (await db.collection('emulatorApnsPushes').where('token', '==', apnsToken).get()).docs
    .map(doc => JSON.parse(doc.data().payload)).filter(push => push.aot.type === type);
  const waitForPush = async (type, match = () => true) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const found = (await pushesTo(type)).find(match);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`no ${type} push reached the iPhone`);
  };
  // test_connection pings both phones; the iPhone's extension answers through the device API.
  const testing = rpc(tokens.access_token, 'tools/call', { name: 'test_connection', arguments: { waitSeconds: 10 } });
  const ping = await waitForPush('ping');
  assert.deepEqual([ping.aot.kind, ping.aot.deviceId, ping.aps['mutable-content']], ['assistant', iphone, 1]);
  assert.equal((await deviceApi('POST', '/v1/ping', { pingId: ping.aot.pingId })).status, 204);
  const tested = await testing;
  assert.deepEqual(tested.structuredContent.received, ['iPhone 17'], JSON.stringify(tested));
  assert.equal((await db.doc(`accounts/${uid}/assistantDevices/${iphone}`).get()).data().lastPing.id, ping.aot.pingId);
  assert.equal((await deviceApi('POST', '/v1/ping', { pingId: 'ping_forged' }, randomBytes(32).toString('base64url'))).status, 401);
  // The extension pulls the connector's values and publishes a snapshot that confirms them.
  const pulled = await deviceApi('POST', '/v1/sync', { since: 0, changeId: changed.structuredContent.changeId }).then(r => r.json());
  assert.deepEqual(pulled.values.map(item => [item.id, item.payload]), [[`e_${'c'.repeat(64)}`, '{"leadTimes":[15],"enabled":true}']]);
  assert.equal(pulled.change.writtenAt, activity.writtenAt.toMillis());
  assert.equal(pulled.change.summary, undefined);
  assert.equal((await deviceApi('PUT', '/v1/snapshot', { payload: JSON.stringify({ device: 'iPhone 17', valuesAppliedThrough: pulled.change.writtenAt, calendars: [], events: [] }) })).status, 204);
  const confirmed = await rpc(tokens.access_token, 'tools/call', { name: 'confirm_change', arguments: { changeId: changed.structuredContent.changeId, waitSeconds: 0 } });
  assert.match(confirmed.content[0].text, /iPhone 17/);

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
  // The app's undo reaches the iPhone as a quiet sync push.
  const undoPush = await waitForPush('sync', push => push.aot.changeId === undone.result.changeId);
  assert.equal(undoPush.aps['interruption-level'], 'passive');
  assert.equal((await call('revokeAssistantConnection', { grantId: listed.result.connections[0].grantId })).result.revoked, true);
  assert.equal((await db.doc(`accounts/${uid}/assistant/state`).get()).data().connected, false);
  assert.equal((await db.collection(`accounts/${uid}/assistantSnapshots`).get()).size, 0);
  // Disconnecting deleted the device documents, so the device key no longer works.
  assert.equal((await deviceApi('POST', '/v1/sync', { since: 0 })).status, 401);
  const after = await fetch(`${site}/mcp`, { method: 'POST', headers: { ...json, Accept: 'application/json, text/event-stream', Authorization: `Bearer ${rotated.access_token}` }, body: '{}' });
  assert.equal(after.status, 401);

  // The review account. The seed script creates it with a password and prints only its uid.
  const demoUid = /^ASSISTANT_DEMO_UID=(.+)$/m.exec(readFileSync(path.join(__dirname, '../.env.local'), 'utf8'))?.[1]?.trim();
  assert.ok(demoUid, 'set ASSISTANT_DEMO_UID in functions/.env.local (see the README)');
  const reviewEmail = 'review@example.test';
  const reviewPassword = randomBytes(18).toString('base64url');
  const seed = () => spawnSync(process.execPath, [path.join(__dirname, '../../scripts/seed-review-account.js'), '--project', 'demo-account-sync', '--email', reviewEmail, '--uid', demoUid], {
    env: { ...process.env, FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9199', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8180', REVIEW_ACCOUNT_PASSWORD: reviewPassword }, encoding: 'utf8',
  });
  const seeded = seed();
  assert.equal(seeded.status, 0, seeded.stderr);
  assert.equal(seeded.stdout, `${demoUid}\n`);
  assert.ok(!seeded.stdout.includes(reviewPassword) && !seeded.stderr.includes(reviewPassword));
  assert.equal((await db.doc(`accounts/${demoUid}`).get()).data().active, true);
  const passwordSignIn = (email, password) => fetch('http://127.0.0.1:9199/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=test', {
    method: 'POST', headers: json, body: JSON.stringify({ email, password, returnSecureToken: true }),
  }).then(r => r.json());
  const reviewer = await passwordSignIn(reviewEmail, reviewPassword);
  assert.equal(reviewer.localId, demoUid, JSON.stringify(reviewer));
  // Any other password account is refused at consent, even with account sync set up.
  const stranger = await fetch('http://127.0.0.1:9199/identitytoolkit.googleapis.com/v1/accounts:signUp?key=test', {
    method: 'POST', headers: json, body: JSON.stringify({ email: `${randomUUID()}@example.test`, password: randomBytes(18).toString('base64url'), returnSecureToken: true }),
  }).then(r => r.json());
  await db.doc(`accounts/${stranger.localId}`).set({ active: true, schemaVersion: 1 });

  /** Registration, authorize, consent and approval with `idToken`; returns the tokens. */
  const connectWith = async idToken => {
    const verifierText = 'e2e-review-' + randomBytes(24).toString('base64url');
    const authorized = await fetch(`${site}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri,
      code_challenge: createHash('sha256').update(verifierText).digest('base64url'), code_challenge_method: 'S256', resource: resource.resource })}`, { redirect: 'manual' });
    const requestId = new URL(authorized.headers.get('location')).searchParams.get('request');
    const consentFor = await fetch(`${site}/oauth/consent`, { method: 'POST', headers: json, body: JSON.stringify({ request: requestId, idToken }) });
    if (consentFor.status !== 200) return { refused: consentFor.status, body: await consentFor.json() };
    assert.equal((await consentFor.json()).account, 'ready');
    const approvedFor = await fetch(`${site}/oauth/approve`, { method: 'POST', headers: json, body: JSON.stringify({ request: requestId, idToken, decision: 'approve' }) }).then(r => r.json());
    return fetch(`${site}/oauth/token`, form({ grant_type: 'authorization_code', code: new URL(approvedFor.redirect).searchParams.get('code'), code_verifier: verifierText,
      client_id: client.client_id, redirect_uri: redirectUri })).then(r => r.json());
  };
  const refused = await connectWith(stranger.idToken);
  assert.deepEqual([refused.refused, refused.body.error], [401, 'login_required']);

  const tool = async (token, name, args = {}) => {
    const out = await rpc(token, 'tools/call', { name, arguments: args });
    assert.equal(out.isError, undefined, `${name}: ${JSON.stringify(out)}`);
    return { ...out, text: out.content.map(item => item.text).join('\n') };
  };
  const review = await connectWith(reviewer.idToken);
  assert.ok(review.access_token, JSON.stringify(review));
  // The stand-in phone registers on the first tool call and answers like a phone.
  assert.match((await tool(review.access_token, 'get_status')).text, /Phone: Pixel 9 \(demo\) \(Android; can receive changes instantly/);
  assert.deepEqual((await tool(review.access_token, 'test_connection', { waitSeconds: 10 })).structuredContent.received, ['Pixel 9 (demo)']);
  const standup = (await tool(review.access_token, 'find_events', { query: 'team standup' })).structuredContent.events[0];
  assert.equal(standup.recurring, true);
  const series = await tool(review.access_token, 'set_series_alarms', { event: standup.eventKey, leadTimes: [25] });
  assert.deepEqual(series.structuredContent.sentTo, ['Pixel 9 (demo)']);
  const seriesConfirmed = await tool(review.access_token, 'confirm_change', { changeId: series.structuredContent.changeId, waitSeconds: 5 });
  assert.equal(seriesConfirmed.structuredContent.outcome, 'confirmed', seriesConfirmed.text);
  const week = await tool(review.access_token, 'list_upcoming_alarms', { to: new Date(Date.now() + 7 * 86400000).toISOString() });
  assert.match(week.text, /"Team standup", 25 min before/);
  assert.match((await tool(review.access_token, 'explain_alarm', { event: standup.eventKey })).text, /series/);
  assert.equal((await tool(review.access_token, 'refresh', { waitSeconds: 10 })).structuredContent.fresh, true);
  // Disconnecting deletes the phone like a real one; reconnecting brings it back, with the settings kept.
  const revoked = await fetch(`${site}/oauth/revoke`, form({ token: review.refresh_token, client_id: client.client_id }));
  assert.equal(revoked.status, 200);
  assert.equal((await db.collection(`accounts/${demoUid}/assistantDevices`).get()).size, 0);
  const again = await connectWith((await passwordSignIn(reviewEmail, reviewPassword)).idToken);
  const back = await tool(again.access_token, 'find_events', { query: 'team standup' });
  assert.match(back.text, /rings 25 min before/);
  // Seeding again resets the settings but keeps the connection.
  assert.equal(seed().status, 0);
  assert.match((await tool(again.access_token, 'find_events', { query: 'team standup' })).text, /rings 10 min before, at start/);

  console.log('PASS: assistant connector OAuth, MCP tools, iPhone pushes and device API, app callables, disconnect and the review account work end to end through Hosting.');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });

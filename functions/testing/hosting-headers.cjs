// Checks the security headers Hosting serves for each kind of page, with the production firebase.json:
//   firebase emulators:exec --only hosting 'node functions/testing/hosting-headers.cjs'
const assert = require('node:assert/strict');
const site = 'http://127.0.0.1:5012';

(async () => {
  const pages = [
    ['/connect/', 200, /script-src 'self' https:\/\/www\.gstatic\.com https:\/\/apis\.google\.com;/],
    ['/delete-account/', 200, /connect-src 'self' [^;]*https:\/\/us-central1-always-on-time-zombit-2026\.cloudfunctions\.net/],
    [`/open/event/e_${'a'.repeat(64)}`, 200, /default-src 'none'; script-src 'self';/],
    ['/account.css', 200, /script-src 'none'/],
    ['/no-such-page', 404, /script-src 'none'/],
  ];
  for (const [path, status, expected] of pages) {
    const response = await fetch(`${site}${path}`, { redirect: 'manual' });
    assert.equal(response.status, status, path);
    const policy = response.headers.get('content-security-policy');
    assert.ok(policy, `${path} has a Content-Security-Policy`);
    // A second policy would be joined with a comma; each page must get exactly one.
    assert.equal(policy.includes(','), false, `${path} has one policy`);
    assert.match(policy, expected, path);
    assert.match(policy, /frame-ancestors 'none'/, path);
    assert.doesNotMatch(policy, /127\.0\.0\.1|localhost/, `${path} allows no local address`);
    assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
  }
  console.log('PASS: every page is served with one Content-Security-Policy that limits scripts and forbids framing.');

  // Android and Apple fetch these without following redirects and expect JSON.
  for (const path of ['/.well-known/assetlinks.json', '/.well-known/apple-app-site-association']) {
    const response = await fetch(`${site}${path}`, { redirect: 'manual' });
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/, path);
    JSON.parse(await response.text());
  }
  console.log('PASS: the App Link and Universal Link association files are served as JSON.');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });

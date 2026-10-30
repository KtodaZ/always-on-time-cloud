import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
// account-web/ has no package.json, so load the browser module from its source.
const { appleDeletionStep, appleProvider, noAccountMessage, notSetUpMessage, signInError, signedInLabel } = await import(
  `data:text/javascript,${encodeURIComponent(read("account-web/sign-in.js"))}`
);

test("Sign in with Apple asks for the email only", () => {
  class FakeOAuthProvider {
    constructor(id) { this.id = id; this.scopes = []; }
    addScope(scope) { this.scopes.push(scope); }
  }
  const provider = appleProvider(FakeOAuthProvider);
  assert.deepEqual([provider.id, provider.scopes], ["apple.com", ["email"]]);
});

test("an email whose account signs in the other way names the button to use", () => {
  const exists = { code: "auth/account-exists-with-different-credential" };
  assert.match(signInError(exists, "apple"), /Use Sign in with Google instead/);
  assert.match(signInError(exists, "google"), /Use Sign in with Apple instead/);
  assert.equal(signInError({ code: "auth/popup-closed-by-user" }, "apple"), "");
  assert.equal(signInError({ code: "auth/cancelled-popup-request" }, "google"), "");
  assert.match(signInError({ code: "auth/popup-blocked" }, "apple"), /blocked/);
  assert.equal(signInError({ code: "auth/internal-error" }, "google"), "Couldn’t sign in. Please try again.");
});

test("an Apple account without an email still says who is signed in", () => {
  assert.equal(signedInLabel({ email: "x@privaterelay.appleid.com", providerData: [{ providerId: "apple.com" }] }), "x@privaterelay.appleid.com");
  assert.equal(signedInLabel({ email: null, providerData: [{ providerId: "apple.com" }] }), "your Apple Account");
  assert.equal(signedInLabel(null), "");
});

test("deleting an Apple account asks for a fresh sign-in only for a restored session", () => {
  assert.equal(appleDeletionStep({ freshSignIn: false, accessToken: null }), "sign-in-again");
  assert.equal(appleDeletionStep({ freshSignIn: false, accessToken: "token" }), "sign-in-again");
  assert.equal(appleDeletionStep({ freshSignIn: true, accessToken: "token" }), "revoke");
  // A fresh popup without a token deletes anyway: a failed revocation never blocks deletion.
  assert.equal(appleDeletionStep({ freshSignIn: true, accessToken: null }), "delete");
});

test("a sign-in no account uses says so and points to the other way in", () => {
  assert.match(noAccountMessage("apple"), /^No Always On Time account uses this Apple sign-in, so there’s nothing to delete\./);
  assert.match(noAccountMessage("apple"), /Sign in with Google/);
  assert.match(noAccountMessage("google"), /this Google sign-in/);
  assert.match(noAccountMessage("google"), /Sign in with Apple/);
  assert.match(notSetUpMessage("apple"), /^No Always On Time account uses this Apple sign-in yet\./);
  assert.match(notSetUpMessage("google"), /Settings › Account & sync/);
});

test("the delete page checks a new sign-in for a stray account before showing it, and the consent page removes a new one", () => {
  const account = read("account-web/account.js");
  assert.match(account, /removeAccount\(\{ onlyIfUnused: true \}\)/);
  assert.match(account, /data\?\.hadAccount === false/);
  const connect = read("account-web/connect/connect.js");
  assert.match(connect, /getAdditionalUserInfo\(result\)\?\.isNewUser/);
  assert.match(connect, /await deleteUser\(user\)/);
});

test("the consent and delete pages offer Google and Apple side by side, and every id the scripts use exists", () => {
  for (const [page, script] of [["account-web/connect/index.html", "account-web/connect/connect.js"], ["account-web/delete-account/index.html", "account-web/account.js"]]) {
    const html = read(page);
    const options = /<div id="sign-in-options" class="providers"[^>]*>([\s\S]*?)<\/div>/.exec(html);
    assert.ok(options, `${page} groups the sign-in buttons`);
    assert.match(options[1], /<button id="sign-in" class="google">[\s\S]*Sign in with Google<\/button>[\s\S]*<button id="sign-in-apple" class="apple">[\s\S]*Sign in with Apple<\/button>/, page);
    assert.doesNotMatch(html, /Google account you use/, `${page} copy covers Apple accounts too`);
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
    for (const [, id] of read(script).matchAll(/element\('([^']+)'\)/g)) assert.ok(ids.has(id), `${script} uses #${id}, missing from ${page}`);
    for (const [, list] of read(script).matchAll(/for \(const id of \[([^\]]+)\]/g)) {
      for (const [, id] of list.matchAll(/'([^']+)'/g)) assert.ok(ids.has(id), `${script} uses #${id}, missing from ${page}`);
    }
  }
});

test("the shared sign-in module is allowed by both pages' script policy", () => {
  const { headers } = JSON.parse(read("firebase.json")).hosting;
  for (const source of ["/connect/**", "/delete-account/**"]) {
    const csp = headers.find((rule) => rule.source === source).headers.find((h) => h.key === "Content-Security-Policy").value;
    assert.match(csp, /script-src 'self'/, source);
  }
});

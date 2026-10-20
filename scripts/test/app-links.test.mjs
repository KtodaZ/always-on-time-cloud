import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const firebase = JSON.parse(read("firebase.json"));

test("apple-app-site-association opens /open links in the iOS app only", () => {
  const { applinks } = JSON.parse(read("account-web/.well-known/apple-app-site-association"));
  assert.deepEqual(applinks.details, [{
    appIDs: ["LRTR5A87Y6.com.zombitstudios.alwaysontime"],
    components: [{ "/": "/open/*" }, { "/": "/open" }],
  }]);
});

test("assetlinks.json names the Android app", () => {
  const [statement] = JSON.parse(read("account-web/.well-known/assetlinks.json"));
  assert.equal(statement.target.package_name, "com.zombitstudios.alwaysontime");
});

test("both association files are served as JSON", () => {
  for (const source of ["/.well-known/assetlinks.json", "/.well-known/apple-app-site-association"]) {
    const rule = firebase.hosting.headers.find((r) => r.source === source);
    assert.ok(rule, `${source} has a header rule`);
    assert.deepEqual(rule.headers, [{ key: "Content-Type", value: "application/json" }], source);
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AUTH_EMULATOR_ORIGIN, emulatorConfig } from "../emulator-config.mjs";

const config = JSON.parse(readFileSync(new URL("../../firebase.json", import.meta.url), "utf8"));
const policies = (c) => c.hosting.headers.flatMap((rule) => rule.headers.filter((h) => h.key === "Content-Security-Policy")
  .map((h) => [rule.source ?? rule.regex, h.value]));

test("production hosting headers never allow a local address", () => {
  for (const [source, value] of policies(config)) {
    assert.doesNotMatch(value, /127\.0\.0\.1|localhost|\[::1\]|http:/, source);
  }
});

test("every page policy limits scripts and forbids framing", () => {
  const sources = new Map(policies(config));
  for (const source of ["^/[^/]*$", "/delete-account/**", "/connect/**", "/open/**"]) {
    const value = sources.get(source);
    assert.ok(value, `${source} has a Content-Security-Policy`);
    assert.match(value, /(^|; )script-src /, source);
    assert.match(value, /(^|; )frame-ancestors 'none'/, source);
    assert.doesNotMatch(value, /'unsafe-eval'|script-src[^;]*'unsafe-inline'/, source);
  }
  // Each page has exactly one policy rule: how Hosting combines overlapping rules isn't documented.
  assert.equal(policies(config).length, sources.size);
});

test("the emulator config adds the Auth emulator to the consent page only", () => {
  const local = emulatorConfig(config);
  const consent = new Map(policies(local)).get("/connect/**");
  assert.match(consent, new RegExp(`connect-src [^;]* ${AUTH_EMULATOR_ORIGIN.replaceAll(".", "\\.")}(;|$)`));
  assert.match(consent, new RegExp(`frame-src [^;]* ${AUTH_EMULATOR_ORIGIN.replaceAll(".", "\\.")}(;|$)`));
  const changed = policies(local).filter(([source, value]) => new Map(policies(config)).get(source) !== value).map(([source]) => source);
  assert.deepEqual(changed, ["/connect/**"]);
  assert.deepEqual({ ...local, hosting: { ...local.hosting, headers: [] } }, { ...config, hosting: { ...config.hosting, headers: [] } });
});

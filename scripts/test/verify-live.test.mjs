import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { execFileSync } from "node:child_process";

import { canonicalJson } from "../live-state.mjs";
import {
  DEPLOY_ACCOUNT, attestationCommit, classifyAuditEntry, compareDirectory, deployStep, describePrincipal, expectedHostingPaths,
  newestHostingDeploy, servingConfig,
} from "../verify-live.mjs";

const entry = (methodName, principalEmail, extra = {}) => ({ protoPayload: {
  methodName, resourceName: "projects/p/locations/us-central1/functions/f", authenticationInfo: { principalEmail }, ...extra,
} });
const person = "someone@example.com";
const ciDelegation = { serviceAccountDelegationInfo: [{ principalSubject:
  "principal://iam.googleapis.com/projects/1054144143721/locations/global/workloadIdentityPools/github/subject/repo:KtodaZ@8885124/always-on-time-cloud@1422600008:environment:production" }] };

test("deploys by a person outside CI are failures", () => {
  for (const method of [
    "google.cloud.functions.v2.FunctionService.UpdateFunction",
    "google.cloud.functions.v1.CloudFunctionsService.CreateFunction",
    "google.firebase.rules.v1.FirebaseRulesService.UpdateRelease",
    "google.firestore.admin.v1.FirestoreAdmin.UpdateField",
    "google.cloud.run.v1.Services.SetIamPolicy",
  ]) assert.equal(classifyAuditEntry(entry(method, person)), "deploy", method);
  assert.equal(classifyAuditEntry({ protoPayload: { serviceName: "firebasehosting.googleapis.com",
    methodName: "google.firebase.hosting.v1beta1.FirebaseHosting.CreateRelease", authenticationInfo: { principalEmail: person } } }), "deploy");
});

test("custom domain changes are listed, not failed", () => {
  const hosting = (methodName) => classifyAuditEntry({ protoPayload: { serviceName: "firebasehosting.googleapis.com", methodName,
    authenticationInfo: { principalEmail: person } } });
  for (const method of ["CreateCustomDomain", "UpdateCustomDomain", "DeleteCustomDomain", "CreateDomain", "UpdateDomain"]) {
    assert.equal(hosting(`google.firebase.hosting.v1beta1.FirebaseHosting.${method}`), "config", method);
  }
  for (const method of ["CreateVersion", "UpdateVersion", "CreateChannel", "CreateSite", "UpdateSiteConfig"]) {
    assert.equal(hosting(`google.firebase.hosting.v1beta1.FirebaseHosting.${method}`), "deploy", method);
  }
});

test("the deploy account is expected only when CI uses it for this repository", () => {
  const method = "google.cloud.functions.v2.FunctionService.UpdateFunction";
  assert.equal(classifyAuditEntry({ protoPayload: { methodName: method, authenticationInfo: { principalEmail: DEPLOY_ACCOUNT, ...ciDelegation } } }), null);
  assert.equal(classifyAuditEntry(entry(method, DEPLOY_ACCOUNT)), "deploy");
  assert.equal(classifyAuditEntry({ protoPayload: { methodName: method, authenticationInfo: { principalEmail: DEPLOY_ACCOUNT,
    serviceAccountDelegationInfo: [{ principalSubject: "principal://iam.googleapis.com/projects/1054144143721/locations/global/workloadIdentityPools/github/subject/repo:someone@1/else@2:ref" }] } } }), "deploy");
  assert.equal(classifyAuditEntry({ protoPayload: { methodName: method, authenticationInfo: { principalEmail: DEPLOY_ACCOUNT,
    serviceAccountDelegationInfo: [{ principalSubject: "principal://iam.googleapis.com/projects/1054144143721/locations/global/workloadIdentityPools/github/subject/repo:KtodaZ@8885124/always-on-time-cloud@999:ref" }] } } }), "deploy");
});

test("CI cannot change who can deploy either", () => {
  const viaCi = (methodName, extra = {}) => ({ protoPayload: { methodName, resourceName: "projects/p",
    authenticationInfo: { principalEmail: DEPLOY_ACCOUNT, ...ciDelegation }, ...extra } });
  assert.equal(classifyAuditEntry(viaCi("google.iam.admin.v1.CreateServiceAccountKey")), "deploy");
  assert.equal(classifyAuditEntry(viaCi("SetIamPolicy", { serviceData: { policyDelta: { bindingDeltas: [
    { action: "ADD", role: "roles/owner", member: "user:attacker@example.com" }] } } })), "deploy");
  assert.equal(classifyAuditEntry(viaCi("SetIamPolicy", { serviceData: { policyDelta: { bindingDeltas: [{ action: "ADD",
    role: "roles/iam.serviceAccountTokenCreator", member: "serviceAccount:service-1054144143721@gcp-sa-pubsub.iam.gserviceaccount.com" }] } } })), null);
});

test("changes to who can deploy are failures", () => {
  assert.equal(classifyAuditEntry(entry("google.iam.v1.WorkloadIdentityPools.CreateWorkloadIdentityPoolProvider", person)), "deploy");
  assert.equal(classifyAuditEntry(entry("google.iam.admin.v1.UploadServiceAccountKey", person)), "deploy");
  assert.equal(classifyAuditEntry(entry("SetIamPolicy", person, { serviceData: { policyDelta: { bindingDeltas: [
    { action: "ADD", role: "roles/iam.serviceAccountTokenCreator", member: "user:attacker@example.com" }] } } })), "deploy");
  assert.equal(classifyAuditEntry(entry("google.iam.admin.v1.SetIAMPolicy", person,
    { resourceName: "projects/-/serviceAccounts/113881711650884068808" })), "deploy");
});

test("look-alike service agents are not trusted", () => {
  const agent = "service-1054144143721@gcf-admin-robot.iam.gserviceaccount.com";
  const fake = "service-12345678@always-on-time-zombit-2026.iam.gserviceaccount.com";
  const method = "google.cloud.functions.v2.FunctionService.UpdateFunction";
  assert.equal(classifyAuditEntry(entry("google.cloud.serverless.internal.InternalServices.ReplaceInternalService", agent)), null);
  assert.equal(classifyAuditEntry(entry(method, fake)), "deploy");
});

test("reads are ignored and other changes are listed as configuration", () => {
  assert.equal(classifyAuditEntry(entry("google.longrunning.Operations.GetOperation", person)), null);
  assert.equal(classifyAuditEntry(entry("google.cloud.secretmanager.v1.SecretManagerService.AddSecretVersion", person)), "config");
  assert.equal(classifyAuditEntry(entry("SetIamPolicy", person, { serviceData: { policyDelta: { bindingDeltas: [
    { action: "ADD", role: "roles/logging.viewer", member: "user:x@example.com" }] } } })), "config");
});

test("reports never show a person's email", () => {
  assert.equal(describePrincipal(person), "a user account");
  assert.equal(describePrincipal(DEPLOY_ACCOUNT), DEPLOY_ACCOUNT);
});

test("hosting expects every account-web file except ignored ones", () => {
  assert.deepEqual(expectedHostingPaths(["account-web/index.html", "account-web/.DS_Store", "account-web/a/b.js", "README.md",
    "account-web/.well-known/assetlinks.json", "account-web/.git/config", "account-web/a/.env"]),
  ["/index.html", "/a/b.js", "/.well-known/assetlinks.json"]);
});

test("the verifier expects exactly the files firebase deploy uploads with firebase.json's ignore list", () => {
  // Runs the Firebase CLI's own file listing over a sample tree, so a change to either side fails here.
  const { listFiles } = createRequire(import.meta.url)("firebase-tools/lib/listFiles");
  const { ignore } = JSON.parse(readFileSync(new URL("../../firebase.json", import.meta.url), "utf8")).hosting;
  const sample = [
    "index.html", "firebase.json", ".DS_Store", ".env", "a/.env", "a/b.js", ".well-known/assetlinks.json", ".well-known/.hidden",
    ".git/config", "a/.hidden/x.js", "node_modules/x/y.js", "open/index.html", "connect/connect.js", ".well-knownx/z",
  ];
  const root = mkdtempSync(join(tmpdir(), "hosting-"));
  for (const path of sample) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "x");
  }
  const deployed = listFiles(root, ignore).map((path) => `/${path}`).sort();
  assert.deepEqual(deployed, expectedHostingPaths(sample.map((path) => `account-web/${path}`)).sort());
  assert.ok(deployed.includes("/.well-known/assetlinks.json"));
  assert.equal(deployed.some((path) => path.includes("/.env") || path.includes(".git")), false);
});

test("the commit and run come from the attestation's provenance", () => {
  const attestation = { verificationResult: { statement: { predicate: {
    buildDefinition: { resolvedDependencies: [{ uri: "git+https://github.com/o/r@refs/heads/main", digest: { gitCommit: "abc123" } }] },
    runDetails: { metadata: { invocationId: "https://github.com/o/r/actions/runs/42/attempts/1" } },
  } } } };
  assert.deepEqual(attestationCommit(attestation), { commit: "abc123", run: "https://github.com/o/r/actions/runs/42" });
});

test("firebase.json converts to Hosting's serving config shape", () => {
  const config = servingConfig({ hosting: {
    public: "account-web", ignore: [],
    headers: [{ source: "**", headers: [{ key: "A", value: "1" }, { key: "B", value: "2" }] }, { regex: "^/[^/]*$", headers: [{ key: "C", value: "3" }] }],
    redirects: [{ source: "/", destination: "https://zombit.io/", type: 301 }],
    rewrites: [{ source: "/mcp", function: { functionId: "assistantMcp", region: "us-central1" } }, { source: "/open/**", destination: "/open/index.html" }],
  } });
  // The shape the Hosting API returned for the live release on 2026-10-18.
  assert.deepEqual(config, {
    headers: [{ glob: "**", headers: { A: "1", B: "2" } }, { regex: "^/[^/]*$", headers: { C: "3" } }],
    redirects: [{ glob: "/", statusCode: 301, location: "https://zombit.io/" }],
    rewrites: [{ glob: "/mcp", run: { serviceId: "assistantmcp", region: "us-central1" } }, { glob: "/open/**", path: "/open/index.html" }],
  });
  assert.throws(() => servingConfig({ hosting: { cleanUrls: true } }), /not compared/);
  assert.throws(() => servingConfig({ hosting: { rewrites: [{ source: "/x", run: { serviceId: "s" } }] } }), /not compared/);
  // The repository's own firebase.json is fully covered.
  assert.ok(servingConfig(JSON.parse(readFileSync(new URL("../../firebase.json", import.meta.url), "utf8"))).headers.length > 0);
});

test("the Deploy step name says what a run deployed", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(deployStep(`Deploy functions,hosting at ${sha}`), { only: "functions,hosting", commit: sha, dryRun: false });
  assert.deepEqual(deployStep(`Deploy hosting at ${sha} (dry run)`), { only: "hosting", commit: sha, dryRun: true });
  assert.equal(deployStep("Deploy hosting at main"), null);
  assert.equal(deployStep("Set up job"), null);
  // deploy.yml must keep producing names this parser reads.
  const workflow = readFileSync(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8");
  const template = /- name: (Deploy \$\{\{ inputs\.only \}\} at .*)$/m.exec(workflow)?.[1];
  assert.equal(template, "Deploy ${{ inputs.only }} at ${{ github.sha }}${{ inputs.dry_run && ' (dry run)' || '' }}");
});

test("the newest hosting deploy skips dry runs, other targets and unsigned runs", async () => {
  const sha = (c) => c.repeat(40);
  const run = (id, commit, extra = {}) => ({ id, head_sha: sha(commit), html_url: `https://github.com/o/r/actions/runs/${id}`,
    conclusion: "success", head_branch: "main", event: "workflow_dispatch", ...extra });
  const jobs = {
    6: [{ name: "deploy", steps: [{ name: `Deploy hosting at ${sha("f")}` }] }, { name: "sign", conclusion: "success" }],
    5: [{ name: "deploy", steps: [{ name: `Deploy storage at ${sha("e")}` }] }, { name: "sign", conclusion: "success" }],
    4: [{ name: "deploy", steps: [{ name: `Deploy hosting at ${sha("d")} (dry run)` }] }, { name: "sign", conclusion: "skipped" }],
    3: [{ name: "deploy", steps: [{ name: `Deploy hosting at ${sha("c")}` }] }, { name: "sign", conclusion: "failure" }],
    2: [{ name: "deploy", steps: [{ name: "Set up job" }, { name: `Deploy functions,firestore,storage,hosting at ${sha("b")}` }] }, { name: "sign", conclusion: "success" }],
    1: [{ name: "deploy", steps: [{ name: `Deploy hosting at ${sha("a")}` }] }, { name: "sign", conclusion: "success" }],
  };
  const runs = [run(6, "f", { head_branch: "other" }), run(5, "e"), run(4, "d"), run(3, "c"), run(2, "b"), run(1, "a")];
  assert.deepEqual(await newestHostingDeploy(runs, (r) => jobs[r.id]), { run: "https://github.com/o/r/actions/runs/2", commit: sha("b") });
  assert.equal(await newestHostingDeploy(runs.slice(0, 2), (r) => jobs[r.id]), null);
});

test("artifacts are compared with the repository before signing", () => {
  const commit = execFileSync("git", ["rev-parse", "HEAD"]).toString().trim();
  const show = (path) => execFileSync("git", ["show", `${commit}:${path}`]);
  const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", commit, "account-web/"]).toString().split("\n").filter(Boolean);
  const write = (files) => {
    const dir = mkdtempSync(join(tmpdir(), "compare-"));
    const manifest = [];
    for (const [artifact, bytes] of files) {
      mkdirSync(dirname(join(dir, artifact.file)), { recursive: true });
      writeFileSync(join(dir, artifact.file), bytes);
      manifest.push(artifact);
    }
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    return dir;
  };
  const config = [{ kind: "hosting-config", name: "hosting/.serving-config.json", file: "hosting-config.json" },
    canonicalJson(servingConfig(JSON.parse(show("firebase.json").toString())))];
  const hosting = expectedHostingPaths(tracked).map((path) => [
    { kind: "hosting", name: `hosting${path}`, file: `hosting${path}`, repoPath: `account-web${path}` }, show(`account-web${path}`)]);
  assert.deepEqual(compareDirectory(write([config, ...hosting]), commit), []);
  // A changed file, a changed header and a missing file are each reported.
  const [first, ...rest] = hosting;
  const changed = compareDirectory(write([[config[0], config[1].replace("DENY", "SAMEORIGIN")], [first[0], Buffer.from("changed")], ...rest.slice(1)]), commit);
  assert.ok(changed.some((p) => p.startsWith("hosting/.serving-config.json:")), changed.join());
  assert.ok(changed.some((p) => p.startsWith(`${first[0].name}:`)), changed.join());
  assert.ok(changed.some((p) => p === `hosting is missing ${rest[0][0].repoPath.slice("account-web".length)}`), changed.join());
  // A rules release with no file here can't be signed.
  assert.deepEqual(compareDirectory(write([[{ kind: "rules", name: "rules/x", file: "x.rules", repoPath: null }, "x"]]), commit), ["rules/x: no file in this repository deploys it"]);
});

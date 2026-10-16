import assert from "node:assert/strict";
import test from "node:test";

import { DEPLOY_ACCOUNT, attestationCommit, classifyAuditEntry, describePrincipal, expectedHostingPaths } from "../verify-live.mjs";

const entry = (methodName, principalEmail, extra = {}) => ({ protoPayload: {
  methodName, resourceName: "projects/p/locations/us-central1/functions/f", authenticationInfo: { principalEmail }, ...extra,
} });
const person = "someone@example.com";
const ciDelegation = { serviceAccountDelegationInfo: [{ principalSubject:
  "principal://iam.googleapis.com/projects/1054144143721/locations/global/workloadIdentityPools/github/subject/repo:KtodaZ/always-on-time-cloud:environment:production" }] };

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

test("the deploy account is expected only when CI uses it for this repository", () => {
  const method = "google.cloud.functions.v2.FunctionService.UpdateFunction";
  assert.equal(classifyAuditEntry({ protoPayload: { methodName: method, authenticationInfo: { principalEmail: DEPLOY_ACCOUNT, ...ciDelegation } } }), null);
  assert.equal(classifyAuditEntry(entry(method, DEPLOY_ACCOUNT)), "deploy");
  assert.equal(classifyAuditEntry({ protoPayload: { methodName: method, authenticationInfo: { principalEmail: DEPLOY_ACCOUNT,
    serviceAccountDelegationInfo: [{ principalSubject: "principal://iam.googleapis.com/projects/1054144143721/locations/global/workloadIdentityPools/github/subject/repo:someone/else:ref" }] } } }), "deploy");
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
  assert.deepEqual(expectedHostingPaths(["account-web/index.html", "account-web/.DS_Store", "account-web/a/b.js", "README.md"]),
    ["/index.html", "/a/b.js"]);
});

test("the commit and run come from the attestation's provenance", () => {
  const attestation = { verificationResult: { statement: { predicate: {
    buildDefinition: { resolvedDependencies: [{ uri: "git+https://github.com/o/r@refs/heads/main", digest: { gitCommit: "abc123" } }] },
    runDetails: { metadata: { invocationId: "https://github.com/o/r/actions/runs/42/attempts/1" } },
  } } } };
  assert.deepEqual(attestationCommit(attestation), { commit: "abc123", run: "https://github.com/o/r/actions/runs/42" });
});

import assert from "node:assert/strict";
import test from "node:test";

import { DEPLOY_ACCOUNT, attestationCommit, classifyAuditEntry, describePrincipal } from "../verify-live.mjs";

const entry = (methodName, principalEmail, resourceName = "projects/p/locations/us-central1/functions/f") =>
  ({ protoPayload: { methodName, resourceName, authenticationInfo: { principalEmail } } });
const person = "someone@example.com";

test("a function deploy by a person outside CI is a failure", () => {
  assert.equal(classifyAuditEntry(entry("google.cloud.functions.v2.FunctionService.UpdateFunction", person)), "deploy");
  assert.equal(classifyAuditEntry(entry("google.firebase.rules.v1.FirebaseRulesService.UpdateRelease", person)), "deploy");
  assert.equal(classifyAuditEntry(entry("google.firestore.admin.v1.FirestoreAdmin.UpdateField", person)), "deploy");
});

test("the same deploy by the CI account is expected", () => {
  assert.equal(classifyAuditEntry(entry("google.cloud.functions.v2.FunctionService.UpdateFunction", DEPLOY_ACCOUNT)), null);
});

test("Google service agents and read-only calls are not reported", () => {
  const agent = "service-1054144143721@gcf-admin-robot.iam.gserviceaccount.com";
  assert.equal(classifyAuditEntry(entry("google.cloud.serverless.internal.InternalServices.ReplaceInternalService", agent)), null);
  assert.equal(classifyAuditEntry(entry("google.longrunning.Operations.GetOperation", person)), null);
  assert.equal(classifyAuditEntry(entry("iam.serviceAccounts.actAs", person)), null);
});

test("other changes outside CI are listed as configuration", () => {
  assert.equal(classifyAuditEntry(entry("google.cloud.secretmanager.v1.SecretManagerService.AddSecretVersion", person)), "config");
});

test("granting access to or minting a key for the deploy account is a failure", () => {
  assert.equal(classifyAuditEntry(entry("google.iam.admin.v1.SetIAMPolicy", person,
    "projects/-/serviceAccounts/113881711650884068808")), "deploy");
  assert.equal(classifyAuditEntry(entry("google.iam.admin.v1.CreateServiceAccountKey", person,
    `projects/-/serviceAccounts/${DEPLOY_ACCOUNT}`)), "deploy");
});

test("reports never show a person's email", () => {
  assert.equal(describePrincipal(person), "a user account");
  assert.equal(describePrincipal(DEPLOY_ACCOUNT), DEPLOY_ACCOUNT);
});

test("the commit and run come from the attestation's provenance", () => {
  const attestation = { verificationResult: { statement: { predicate: {
    buildDefinition: { resolvedDependencies: [{ uri: "git+https://github.com/o/r@refs/heads/main", digest: { gitCommit: "abc123" } }] },
    runDetails: { metadata: { invocationId: "https://github.com/o/r/actions/runs/42/attempts/1" } },
  } } } };
  assert.deepEqual(attestationCommit(attestation), { commit: "abc123", run: "https://github.com/o/r/actions/runs/42" });
});

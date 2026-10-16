// Checks that production is exactly what this repository's Deploy workflow shipped from main.
//
// 1. Signatures: every live artifact (function source archives and settings, rules, Firestore
//    indexes, hosting files and serving config) must have a build provenance attestation signed by
//    .github/workflows/deploy.yml on refs/heads/main.
// 2. Contents: source archives, rules, indexes and hosting files must match the repository at the
//    commit named in their attestation, and no file from that commit may be missing from hosting.
// 3. Inventory: nothing may run outside what this repository deploys (other Cloud Run services,
//    hosting sites or channels, Firestore databases).
// 4. Audit log: Google Cloud's Admin Activity log, from MONITORING_STARTS, must show no deploys or
//    changes to deploy trust by anyone other than the CI deploy account acting for this repository.
//    Other configuration changes are listed for transparency.
//
// Usage: node scripts/verify-live.mjs
// Needs GOOGLE_ACCESS_TOKEN (read-only verifier account) and GH_TOKEN, and a full git history.
// Writes a Markdown report to $GITHUB_STEP_SUMMARY when set. Exits 1 if anything fails.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALL_TARGETS, HOSTING_SITE, PROJECT, canonicalJson, collect, listFunctions, listRunServices, normalizeIndexes,
  selectTargets, writeArtifacts,
} from "./live-state.mjs";

export const REPOSITORY = "KtodaZ/always-on-time-cloud";
export const PROJECT_NUMBER = "1054144143721";
export const SIGNER_IDENTITY = `https://github.com/${REPOSITORY}/.github/workflows/deploy.yml@refs/heads/main`;
export const DEPLOY_ACCOUNT = `github-deploy@${PROJECT}.iam.gserviceaccount.com`;
export const VERIFY_ACCOUNT = `github-verify@${PROJECT}.iam.gserviceaccount.com`;
// Audit entries name service accounts by email or by numeric unique ID.
const PIPELINE_ACCOUNTS = [DEPLOY_ACCOUNT, VERIFY_ACCOUNT, "113881711650884068808", "111698826332115105244"];
// CI acts as the deploy account through this repository's Workload Identity pool.
const CI_SUBJECT_PREFIX =
  `principal://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/subject/repo:${REPOSITORY}:`;
// Audit monitoring covers changes from this moment on; the one-time setup before it is described in
// docs/DEPLOYING.md.
export const MONITORING_STARTS = "2026-10-16T23:00:00Z";

// Changes that replace live code, settings, rules, indexes or hosting.
const DEPLOY_METHODS = [
  /^google\.cloud\.functions\.v\d+\.(FunctionService|CloudFunctionsService)\.(Create|Update|Delete)Function$/,
  /^google\.cloud\.functions\.v\d+\.(FunctionService|CloudFunctionsService)\.SetIamPolicy$/,
  /^google\.firebase\.rules\.v1\.FirebaseRulesService\.(Create|Update|Delete)Release$/,
  /^google\.cloud\.run\.v\d+\.Services\.(Create|Replace|Update|Delete)Service$/,
  /^google\.cloud\.run\.v\d+\.Services\.SetIamPolicy$/,
  /^google\.cloud\.scheduler\.v1\.CloudScheduler\.(Create|Update|Delete)Job$/,
  /^google\.cloud\.eventarc\.v1\.Eventarc\.(Create|Update|Delete)Trigger$/,
  /^google\.firestore\.admin\.v1\.FirestoreAdmin\.(UpdateField|CreateIndex|DeleteIndex|CreateDatabase|UpdateDatabase|DeleteDatabase)$/,
];
// Changes to who can deploy: new identity trust, keys, or roles that allow impersonation.
const TRUST_METHODS = /WorkloadIdentityPool|ServiceAccountKey|CreateServiceAccount$|DeleteServiceAccount$|UndeleteServiceAccount$/;
const TRUST_ROLES = new Set([
  "roles/owner", "roles/editor", "roles/iam.serviceAccountTokenCreator", "roles/iam.serviceAccountUser",
  "roles/iam.workloadIdentityUser", "roles/iam.serviceAccountKeyAdmin", "roles/iam.serviceAccountAdmin",
  "roles/iam.securityAdmin", "roles/resourcemanager.projectIamAdmin", "roles/iam.workloadIdentityPoolAdmin",
]);
// Reads and bookkeeping that change nothing.
const IGNORED_METHODS = /(\.Get[A-Z]\w*|\.List[A-Z]\w*|\.TestIamPermissions|actAs|GenerateUploadUrl|GenerateDownloadUrl|GetOperation)$/;
// This project's Google-managed service agents, which act during a deploy someone else started. Their
// domains belong to Google, so no one can create a look-alike account.
const SERVICE_AGENT = new RegExp(
  `^(service-${PROJECT_NUMBER}@(gcp-sa-[a-z0-9-]+|gcf-admin-robot|serverless-robot-prod)\\.iam\\.gserviceaccount\\.com|` +
  "service-agent-manager@system\\.gserviceaccount\\.com)$",
);

/** Public reports never name a person: user accounts are shown generically. */
export function describePrincipal(email) {
  if (!email) return "unknown account";
  if (email.endsWith(".gserviceaccount.com")) return email;
  return "a user account";
}

function grantsTrust(payload) {
  const deltas = payload.serviceData?.policyDelta?.bindingDeltas ?? payload.metadata?.policyDelta?.bindingDeltas ?? [];
  // Firebase deploys may grant this project's Google-managed service agents roles such as token
  // creator for Pub/Sub; nobody can sign in as those.
  return deltas.some((d) => d.action === "ADD" && !SERVICE_AGENT.test(d.member?.replace(/^serviceAccount:/, "") ?? "") &&
    (TRUST_ROLES.has(d.role) || PIPELINE_ACCOUNTS.some((id) => d.member?.includes(id))));
}

/**
 * Sorts an Admin Activity entry into `deploy` (a failure: code or deploy trust changed outside CI),
 * `config` (another change outside CI, listed), or null (expected or read-only).
 */
export function classifyAuditEntry(entry) {
  const payload = entry.protoPayload ?? {};
  const method = payload.methodName ?? "";
  const service = payload.serviceName ?? "";
  const auth = payload.authenticationInfo ?? {};
  const principal = auth.principalEmail ?? "";
  const resource = payload.resourceName ?? "";
  if (IGNORED_METHODS.test(method) || SERVICE_AGENT.test(principal)) return null;
  // Changing who can deploy is never part of a deploy, so it fails even when CI does it.
  if (TRUST_METHODS.test(method)) return "deploy";
  if (/SetI[Aa][Mm]Policy$/.test(method) &&
      (grantsTrust(payload) || PIPELINE_ACCOUNTS.some((id) => resource.includes(id)))) return "deploy";
  if (principal === DEPLOY_ACCOUNT) {
    // The deploy account is only expected when CI uses it for this repository.
    const viaCi = (auth.serviceAccountDelegationInfo ?? []).some((d) => d.principalSubject?.startsWith(CI_SUBJECT_PREFIX));
    return viaCi ? null : "deploy";
  }
  if (service === "firebasehosting.googleapis.com" && !/\.(Get|List)\w*$/.test(method)) return "deploy";
  return DEPLOY_METHODS.some((pattern) => pattern.test(method)) ? "deploy" : "config";
}

export function attestationCommit(attestation) {
  const predicate = attestation?.verificationResult?.statement?.predicate ?? {};
  const commit = predicate.buildDefinition?.resolvedDependencies?.find((d) => d.digest?.gitCommit)?.digest?.gitCommit;
  const run = predicate.runDetails?.metadata?.invocationId?.replace(/\/attempts\/\d+$/, "");
  return { commit, run };
}

/** Hosting paths firebase.json deploys from account-web (it ignores dotfiles and node_modules). */
export function expectedHostingPaths(repoPaths) {
  return repoPaths.filter((p) => p.startsWith("account-web/"))
    .map((p) => p.slice("account-web".length))
    .filter((p) => !p.split("/").some((part) => part.startsWith(".") || part === "node_modules") && p !== "/firebase.json");
}

function git(...args) {
  return execFileSync("git", args, { maxBuffer: 64 * 1024 * 1024 });
}

function fileAtCommit(commit, path) {
  try {
    return git("show", `${commit}:${path}`);
  } catch {
    return null;
  }
}

/** unzip treats entry names as patterns; escape them so each names exactly one file. */
const zipEntry = (name) => name.replace(/[[\]*?\\]/g, "\\$&");

/** Compares a function source archive with `functions/` at the commit. Returns mismatch messages. */
function compareFunctionArchive(zipPath, commit) {
  const entries = execFileSync("unzip", ["-Z1", zipPath]).toString().split("\n").filter((e) => e && !e.endsWith("/"));
  const tracked = git("ls-tree", "-r", "--name-only", commit, "functions/").toString().split("\n")
    .filter(Boolean).map((p) => p.slice("functions/".length));
  const problems = [];
  for (const entry of entries) {
    const expected = fileAtCommit(commit, `functions/${entry}`);
    if (!expected) problems.push(`${entry} is not in the repository`);
    else if (!execFileSync("unzip", ["-p", zipPath, zipEntry(entry)], { maxBuffer: 64 * 1024 * 1024 }).equals(expected)) {
      problems.push(`${entry} differs`);
    }
  }
  for (const path of tracked) if (!entries.includes(path)) problems.push(`${path} is missing`);
  return problems;
}

function compareContents(artifact, path, commit) {
  if (artifact.kind === "function") return compareFunctionArchive(path, commit);
  if (artifact.kind === "indexes") {
    const repo = fileAtCommit(commit, artifact.repoPath);
    if (!repo) return [`${artifact.repoPath} is not in the repository`];
    return canonicalJson(normalizeIndexes(JSON.parse(repo.toString()))) === readFileSync(path, "utf8")
      ? [] : [`differs from ${artifact.repoPath}`];
  }
  if (artifact.kind === "rules" || artifact.kind === "hosting") {
    if (!artifact.repoPath) return ["no file in this repository deploys it"];
    return fileAtCommit(commit, artifact.repoPath)?.equals(readFileSync(path)) ? [] : [`differs from ${artifact.repoPath}`];
  }
  // Function and hosting settings have no single repository file; their signature is the check.
  return [];
}

function verifySignature(path) {
  const output = execFileSync("gh", [
    "attestation", "verify", path,
    "--repo", REPOSITORY,
    "--cert-identity", SIGNER_IDENTITY,
    "--cert-oidc-issuer", "https://token.actions.githubusercontent.com",
    "--source-ref", "refs/heads/main",
    "--deny-self-hosted-runners",
    "--format", "json",
  ], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const { commit, run } = attestationCommit(JSON.parse(output.toString())[0]);
  if (!commit) throw new Error("attestation names no commit");
  return { commit, run };
}

async function google(token, url, init = {}) {
  const response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

/** Things running in the project that this repository does not deploy. */
async function inventoryProblems(token) {
  const problems = [];
  const functions = await listFunctions(token);
  const functionServices = new Set(functions.map((fn) => fn.serviceConfig?.service).filter(Boolean));
  for (const service of await listRunServices(token)) {
    if (!functionServices.has(service.name)) problems.push(`Cloud Run service ${service.name.split("/").pop()} is not a deployed function`);
  }
  const { sites = [] } = await google(token, `https://firebasehosting.googleapis.com/v1beta1/projects/${PROJECT}/sites`);
  for (const site of sites) {
    if (!site.name.endsWith(`/sites/${HOSTING_SITE}`)) problems.push(`Hosting site ${site.name.split("/").pop()} is not deployed from this repository`);
  }
  const { channels = [] } = await google(token, `https://firebasehosting.googleapis.com/v1beta1/sites/${HOSTING_SITE}/channels`);
  for (const channel of channels) {
    if (!channel.name.endsWith("/channels/live") && channel.release) problems.push(`Hosting preview channel ${channel.name.split("/").pop()} is serving content`);
  }
  const { databases = [] } = await google(token, `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases`);
  for (const database of databases) {
    if (!database.name.endsWith("/databases/(default)")) problems.push(`Firestore database ${database.name.split("/").pop()} has no rules or indexes here`);
  }
  return problems;
}

async function auditEntries(token, sinceIso) {
  const filter = `logName="projects/${PROJECT}/logs/cloudaudit.googleapis.com%2Factivity" AND timestamp>="${sinceIso}"`;
  const entries = [];
  let pageToken;
  do {
    const page = await google(token, "https://logging.googleapis.com/v2/entries:list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resourceNames: [`projects/${PROJECT}`], filter, orderBy: "timestamp asc", pageSize: 1000, pageToken }),
    });
    entries.push(...(page.entries ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return entries;
}

async function main() {
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if (!token) throw new Error("GOOGLE_ACCESS_TOKEN is required");
  const report = [];
  let failed = false;
  const fail = (message) => {
    failed = true;
    report.push(`❌ ${message}`, "");
  };

  // 1 and 2: signatures and contents.
  const rows = [];
  let hostingCommit;
  let hostingLive = [];
  try {
    const dir = mkdtempSync(join(tmpdir(), "live-"));
    const artifacts = await collect(token, selectTargets(ALL_TARGETS));
    await writeArtifacts(dir, artifacts);
    for (const artifact of artifacts) {
      const path = join(dir, artifact.file);
      let problems = [];
      let commit;
      let run;
      try {
        ({ commit, run } = verifySignature(path));
        problems = compareContents(artifact, path, commit);
      } catch (error) {
        problems = ["no valid signature from the Deploy workflow on main"];
        if (process.env.VERBOSE) console.error(artifact.name, error.stderr?.toString() ?? error.message);
      }
      if (artifact.kind === "hosting") {
        hostingLive.push(artifact.repoPath.slice("account-web".length));
        if (commit) hostingCommit ??= commit;
      }
      if (problems.length) failed = true;
      const where = commit ? `[\`${commit.slice(0, 7)}\`](https://github.com/${REPOSITORY}/commit/${commit})` +
        (run ? ` ([run](${run}))` : "") : "—";
      rows.push(`| ${problems.length ? "❌" : "✅"} | \`${artifact.name}\` | \`${artifact.sha256.slice(0, 12)}\` | ${where} | ${problems.join("; ")} |`);
    }
  } catch (error) {
    fail(`Could not read production: ${error.message}`);
  }
  report.push("### Live artifacts", "", "| | Artifact | SHA-256 | Signed deploy | Problem |", "| --- | --- | --- | --- | --- |", ...rows, "");
  if (hostingCommit) {
    const repoPaths = git("ls-tree", "-r", "--name-only", hostingCommit, "account-web/").toString().split("\n").filter(Boolean);
    for (const path of expectedHostingPaths(repoPaths)) {
      if (!hostingLive.includes(path)) fail(`Hosting is missing ${path} from the signed commit`);
    }
  }

  // 3: inventory.
  try {
    for (const problem of await inventoryProblems(token)) fail(problem);
  } catch (error) {
    fail(`Could not list project resources: ${error.message}`);
  }

  // 4: audit log, always from the start of monitoring so nothing ages out.
  try {
    const findings = (await auditEntries(token, MONITORING_STARTS))
      .map((entry) => ({ entry, kind: classifyAuditEntry(entry) }))
      .filter(({ kind }) => kind);
    const deploys = findings.filter(({ kind }) => kind === "deploy");
    if (deploys.length) failed = true;
    const line = ({ entry, kind }) => {
      const p = entry.protoPayload;
      return `| ${kind === "deploy" ? "❌" : ""} | ${entry.timestamp} | \`${p.methodName}\` | ` +
        `\`${(p.resourceName ?? "").split("/").slice(-2).join("/")}\` | ${describePrincipal(p.authenticationInfo?.principalEmail)} |`;
    };
    report.push(`### Changes outside the Deploy workflow since ${MONITORING_STARTS}`, "");
    if (!findings.length) report.push("None.", "");
    else {
      report.push("| | Time | Change | Resource | By |", "| --- | --- | --- | --- | --- |", ...findings.map(line), "",
        "❌ marks a change to live code, settings, rules, indexes or hosting, or to who can deploy, made outside CI. " +
        "Other rows are configuration changes (for example secret rotation) listed for transparency.", "");
    }
  } catch (error) {
    fail(`Could not read the audit log: ${error.message}`);
  }

  const heading = failed
    ? "## ❌ Production does not match signed deploys from main"
    : "## ✅ Production matches signed deploys from main";
  const markdown = [heading, "", ...report].join("\n");
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

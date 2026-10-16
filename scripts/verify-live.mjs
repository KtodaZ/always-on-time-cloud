// Checks that production is exactly what this repository's Deploy workflow shipped from main.
//
// 1. Signatures: every live artifact (function source archives, rules, hosting files) must have a
//    build provenance attestation signed by .github/workflows/deploy.yml on refs/heads/main.
// 2. Contents: each artifact must match the files at the commit named in its attestation.
// 3. Audit log: Google Cloud's Admin Activity log must show no deploys by anyone other than the
//    CI deploy account. Other configuration changes are listed for transparency.
//
// Usage: node scripts/verify-live.mjs [--since-hours 26]
// Needs GOOGLE_ACCESS_TOKEN (read-only verifier account) and GH_TOKEN, and a full git history.
// Writes a Markdown report to $GITHUB_STEP_SUMMARY when set. Exits 1 if anything fails.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { ALL_TARGETS, PROJECT, collect, selectTargets, writeArtifacts } from "./live-state.mjs";

export const REPOSITORY = "KtodaZ/always-on-time-cloud";
export const SIGNER_WORKFLOW = `${REPOSITORY}/.github/workflows/deploy.yml`;
export const DEPLOY_ACCOUNT = `github-deploy@${PROJECT}.iam.gserviceaccount.com`;
// Audit entries name the deploy account by email or by its numeric unique ID.
const DEPLOY_ACCOUNT_IDS = [DEPLOY_ACCOUNT, "serviceAccounts/113881711650884068808"];
// Audit monitoring covers changes from this moment on; the one-time setup before it is described in
// docs/DEPLOYING.md.
export const MONITORING_STARTS = "2026-10-16T23:00:00Z";

// Changes made by these replace live code, rules or indexes. Only the CI deploy account may make them.
const DEPLOY_METHODS = [
  /^google\.cloud\.functions\.v\d+\.FunctionService\.(Create|Update|Delete)Function$/,
  /^google\.firebase\.rules\.v1\.FirebaseRulesService\.(Create|Update|Delete)Release$/,
  /^google\.cloud\.run\.v\d+\.Services\.(Create|Replace|Update|Delete)Service$/,
  /^google\.cloud\.scheduler\.v1\.CloudScheduler\.(Create|Update|Delete)Job$/,
  /^google\.firestore\.admin\.v1\.FirestoreAdmin\.(UpdateField|CreateIndex|DeleteIndex)$/,
];
// Reads and bookkeeping that change nothing.
const IGNORED_METHODS = /(\.Get[A-Z]\w*|\.List[A-Z]\w*|actAs|GenerateUploadUrl|GenerateDownloadUrl)$/;
// Google-managed service agents act on Google's behalf during a deploy that someone else started.
const SERVICE_AGENT = /^(service-\d+@[\w-]+\.iam\.gserviceaccount\.com|[\w-]+@system\.gserviceaccount\.com|\d+@cloudservices\.gserviceaccount\.com|\d+@cloudbuild\.gserviceaccount\.com)$/;

/** Public reports never name a person: user accounts are shown generically. */
export function describePrincipal(email) {
  if (!email) return "unknown account";
  if (email.endsWith(".gserviceaccount.com")) return email;
  return "a user account";
}

/**
 * Sorts an Admin Activity entry into `deploy` (code changed outside CI: a failure), `config`
 * (another change outside CI: listed), or null (expected or read-only).
 */
export function classifyAuditEntry(entry) {
  const payload = entry.protoPayload ?? {};
  const method = payload.methodName ?? "";
  const principal = payload.authenticationInfo?.principalEmail ?? "";
  const resource = payload.resourceName ?? "";
  if (IGNORED_METHODS.test(method) || SERVICE_AGENT.test(principal)) return null;
  // Minting a key for, or granting access to, the deploy account would allow deploys outside CI.
  if (DEPLOY_ACCOUNT_IDS.some((id) => resource.includes(id)) && /CreateServiceAccountKey|SetIamPolicy/i.test(method)) {
    return principal === DEPLOY_ACCOUNT ? null : "deploy";
  }
  if (principal === DEPLOY_ACCOUNT) return null;
  return DEPLOY_METHODS.some((pattern) => pattern.test(method)) ? "deploy" : "config";
}

export function attestationCommit(attestation) {
  const predicate = attestation?.verificationResult?.statement?.predicate ?? {};
  const commit = predicate.buildDefinition?.resolvedDependencies?.find((d) => d.digest?.gitCommit)?.digest?.gitCommit;
  const run = predicate.runDetails?.metadata?.invocationId?.replace(/\/attempts\/\d+$/, "");
  return { commit, run };
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

/** Compares a function source archive with `functions/` at the commit. Returns mismatch messages. */
function compareFunctionArchive(zipPath, commit) {
  const entries = execFileSync("unzip", ["-Z1", zipPath]).toString().split("\n").filter((e) => e && !e.endsWith("/"));
  const tracked = git("ls-tree", "-r", "--name-only", commit, "functions/").toString().split("\n")
    .filter(Boolean).map((p) => p.slice("functions/".length));
  const problems = [];
  for (const entry of entries) {
    const expected = fileAtCommit(commit, `functions/${entry}`);
    if (!expected) problems.push(`${entry} is not in the repository`);
    else if (!execFileSync("unzip", ["-p", zipPath, entry], { maxBuffer: 64 * 1024 * 1024 }).equals(expected)) {
      problems.push(`${entry} differs`);
    }
  }
  for (const path of tracked) if (!entries.includes(path)) problems.push(`${path} is missing`);
  return problems;
}

async function auditEntries(token, sinceIso) {
  const filter = [
    `logName="projects/${PROJECT}/logs/cloudaudit.googleapis.com%2Factivity"`,
    `timestamp>="${sinceIso}"`,
  ].join(" AND ");
  const entries = [];
  let pageToken;
  do {
    const response = await fetch("https://logging.googleapis.com/v2/entries:list", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ resourceNames: [`projects/${PROJECT}`], filter, orderBy: "timestamp asc", pageSize: 1000, pageToken }),
    });
    if (!response.ok) throw new Error(`Audit log query returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const page = await response.json();
    entries.push(...(page.entries ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return entries;
}

async function main() {
  const { values } = parseArgs({ options: { "since-hours": { type: "string", default: "26" } } });
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if (!token) throw new Error("GOOGLE_ACCESS_TOKEN is required");
  const report = [];
  let failed = false;

  // 1 and 2: signatures and contents.
  const dir = mkdtempSync(join(tmpdir(), "live-"));
  const artifacts = await collect(token, selectTargets(ALL_TARGETS));
  await writeArtifacts(dir, artifacts);
  const rows = [];
  for (const artifact of artifacts) {
    const path = join(dir, artifact.file);
    let status = "✅";
    let detail = "";
    let commit;
    let run;
    try {
      const output = execFileSync("gh", [
        "attestation", "verify", path,
        "--repo", REPOSITORY,
        "--signer-workflow", SIGNER_WORKFLOW,
        "--source-ref", "refs/heads/main",
        "--format", "json",
      ], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
      ({ commit, run } = attestationCommit(JSON.parse(output.toString())[0]));
      if (!commit) throw new Error("attestation names no commit");
      const problems = artifact.kind === "function"
        ? compareFunctionArchive(path, commit)
        : (fileAtCommit(commit, artifact.repoPath)?.equals(readFileSync(path)) ? [] : [`differs from ${artifact.repoPath}`]);
      if (problems.length) {
        status = "❌";
        detail = problems.join("; ");
      }
    } catch (error) {
      status = "❌";
      detail = "no valid signature from the Deploy workflow on main";
      if (process.env.VERBOSE) console.error(artifact.name, error.stderr?.toString() ?? error.message);
    }
    if (status === "❌") failed = true;
    const where = commit ? `[\`${commit.slice(0, 7)}\`](https://github.com/${REPOSITORY}/commit/${commit})` +
      (run ? ` ([run](${run}))` : "") : "—";
    rows.push(`| ${status} | \`${artifact.name}\` | \`${artifact.sha256.slice(0, 12)}\` | ${where} | ${detail} |`);
  }
  report.push("### Live artifacts", "", "| | Artifact | SHA-256 | Signed deploy | Problem |", "| --- | --- | --- | --- | --- |", ...rows, "");

  // 3: audit log.
  const since = new Date(Math.max(Date.now() - Number(values["since-hours"]) * 3_600_000, Date.parse(MONITORING_STARTS)))
    .toISOString();
  const findings = (await auditEntries(token, since))
    .map((entry) => ({ entry, kind: classifyAuditEntry(entry) }))
    .filter(({ kind }) => kind);
  const deploys = findings.filter(({ kind }) => kind === "deploy");
  if (deploys.length) failed = true;
  const line = ({ entry }) => {
    const p = entry.protoPayload;
    return `| ${entry.timestamp} | \`${p.methodName}\` | \`${(p.resourceName ?? "").split("/").slice(-2).join("/")}\` | ${describePrincipal(p.authenticationInfo?.principalEmail)} |`;
  };
  report.push(`### Changes outside the Deploy workflow since ${since}`, "");
  if (!findings.length) report.push("None.", "");
  else {
    report.push("| Time | Change | Resource | By |", "| --- | --- | --- | --- |",
      ...deploys.map((f) => line(f).replace(/^\| /, "| ❌ ")), ...findings.filter((f) => f.kind === "config").map(line), "");
    if (deploys.length) report.push("❌ marks a change to live code, rules or indexes made outside CI.", "");
    else report.push("These are configuration changes (secrets, permissions, settings), not code deploys.", "");
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

// Downloads what is actually live in production, byte for byte, so it can be signed after a deploy
// and checked against those signatures later:
//   - each Cloud Function's source archive (the exact zip Google built it from),
//   - the active Firestore and Storage rules,
//   - every file in the live Firebase Hosting release.
//
// Usage: node scripts/live-state.mjs --out <dir> [--targets <firebase --only value>]
// Needs GOOGLE_ACCESS_TOKEN with read access. Writes the files, manifest.json and checksums.txt
// (shasum format, the input for actions/attest).

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export const PROJECT = "always-on-time-zombit-2026";
export const REGION = "us-central1";
export const HOSTING_SITE = PROJECT;
export const HOSTING_ORIGIN = `https://${HOSTING_SITE}.web.app`;

/**
 * Maps a `firebase deploy --only` value to the artifacts that deploy replaces. `functions` means
 * every function; `functions:a,functions:b` means just those. Index-only Firestore deploys change no
 * signed artifact.
 */
export function selectTargets(only) {
  const selection = { allFunctions: false, functions: new Set(), firestoreRules: false, storageRules: false, hosting: false };
  for (const raw of (only ?? "").split(",")) {
    const target = raw.trim();
    if (!target) continue;
    const [service, detail] = target.split(/:(.*)/s);
    if (service === "functions") {
      if (!detail) selection.allFunctions = true;
      else selection.functions.add(detail.split(":").pop());
    } else if (service === "firestore") {
      if (!detail || detail === "rules") selection.firestoreRules = true;
    } else if (service === "storage") {
      selection.storageRules = true;
    } else if (service === "hosting") {
      selection.hosting = true;
    } else {
      throw new Error(`Unknown deploy target: ${target}`);
    }
  }
  return selection;
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function google(token, url) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response;
}

async function listFunctions(token) {
  const functions = [];
  let pageToken = "";
  do {
    const url = `https://cloudfunctions.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/functions?pageSize=100` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const page = await (await google(token, url)).json();
    functions.push(...(page.functions ?? []));
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  return functions;
}

async function functionArchive(token, fn) {
  const source = fn.buildConfig?.source?.storageSource;
  if (!source?.bucket || !source?.object) throw new Error(`${fn.name} has no stored source archive`);
  const url = `https://storage.googleapis.com/storage/v1/b/${source.bucket}/o/${encodeURIComponent(source.object)}` +
    `?alt=media&generation=${source.generation}`;
  return { bytes: Buffer.from(await (await google(token, url)).arrayBuffer()), source };
}

async function liveRules(token, release, fileName) {
  const base = `https://firebaserules.googleapis.com/v1/projects/${PROJECT}`;
  const { rulesetName } = await (await google(token, `${base}/releases/${release}`)).json();
  const ruleset = await (await google(token, `https://firebaserules.googleapis.com/v1/${rulesetName}`)).json();
  const files = ruleset.source?.files ?? [];
  if (files.length !== 1) throw new Error(`${release} ruleset has ${files.length} files; expected only ${fileName}`);
  return { bytes: Buffer.from(files[0].content, "utf8"), source: { release, ruleset: rulesetName, file: files[0].name } };
}

async function liveHostingFiles(token) {
  const base = "https://firebasehosting.googleapis.com/v1beta1";
  const { releases } = await (await google(token, `${base}/sites/${HOSTING_SITE}/channels/live/releases?pageSize=1`)).json();
  const version = releases?.[0]?.version?.name;
  if (!version) throw new Error("No live hosting release");
  const files = [];
  let pageToken = "";
  do {
    const page = await (await google(token, `${base}/${version}/files?pageSize=1000` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""))).json();
    files.push(...(page.files ?? []));
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  const result = [];
  for (const file of files) {
    // /__/ is Firebase's reserved namespace (generated SDK config), not deployed content.
    if (file.path.startsWith("/__/")) continue;
    // Served bytes are what visitors get; fetch decodes any transfer compression.
    const response = await fetch(`${HOSTING_ORIGIN}${file.path}`, { cache: "no-store", redirect: "manual" });
    if (!response.ok) throw new Error(`${file.path} returned HTTP ${response.status}`);
    result.push({ path: file.path, bytes: Buffer.from(await response.arrayBuffer()), source: { version } });
  }
  return result;
}

/** Collects the selected live artifacts. Pass `selectTargets("functions,firestore,storage,hosting")` for everything. */
export async function collect(token, selection) {
  const artifacts = [];
  const wanted = (name) => selection.allFunctions || selection.functions.has(name);
  if (selection.allFunctions || selection.functions.size > 0) {
    const functions = await listFunctions(token);
    const names = new Set(functions.map((fn) => fn.name.split("/").pop()));
    for (const name of selection.functions) {
      if (!names.has(name)) throw new Error(`Function ${name} is not deployed`);
    }
    for (const fn of functions) {
      const name = fn.name.split("/").pop();
      if (!wanted(name)) continue;
      const { bytes, source } = await functionArchive(token, fn);
      artifacts.push({ kind: "function", name: `functions/${name}/function-source.zip`, file: `functions/${name}.zip`, bytes, source });
    }
  }
  if (selection.firestoreRules) {
    const { bytes, source } = await liveRules(token, "cloud.firestore", "firestore.rules");
    artifacts.push({ kind: "rules", name: "rules/firestore.rules", file: "rules/firestore.rules", repoPath: "firestore.rules", bytes, source });
  }
  if (selection.storageRules) {
    const { bytes, source } = await liveRules(token, `firebase.storage/${PROJECT}.firebasestorage.app`, "storage.rules");
    artifacts.push({ kind: "rules", name: "rules/storage.rules", file: "rules/storage.rules", repoPath: "storage.rules", bytes, source });
  }
  if (selection.hosting) {
    for (const { path, bytes, source } of await liveHostingFiles(token)) {
      artifacts.push({ kind: "hosting", name: `hosting${path}`, file: `hosting${path}`, repoPath: `account-web${path}`, bytes, source });
    }
  }
  return artifacts.map((artifact) => ({ ...artifact, sha256: sha256(artifact.bytes) }));
}

export async function writeArtifacts(outDir, artifacts) {
  for (const artifact of artifacts) {
    const path = join(outDir, artifact.file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, artifact.bytes);
  }
  const manifest = artifacts.map(({ bytes, ...rest }) => rest);
  await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(join(outDir, "checksums.txt"), artifacts.map((a) => `${a.sha256}  ${a.name}\n`).join(""));
  return manifest;
}

export const ALL_TARGETS = "functions,firestore,storage,hosting";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: "string" }, targets: { type: "string", default: ALL_TARGETS } } });
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if (!values.out || !token) {
    console.error("Usage: GOOGLE_ACCESS_TOKEN=... node scripts/live-state.mjs --out <dir> [--targets <only>]");
    process.exit(2);
  }
  const manifest = await writeArtifacts(values.out, await collect(token, selectTargets(values.targets)));
  for (const item of manifest) console.log(`${item.sha256}  ${item.name}`);
}

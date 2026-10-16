// Downloads what is actually live in production, byte for byte, so it can be signed after a deploy
// and checked against those signatures later:
//   - each Cloud Function's source archive (the exact zip Google built it from) and its settings
//     (runtime, memory, environment, secrets, trigger, ingress, service account, who may invoke it),
//   - every active Firestore and Storage rules release,
//   - Firestore indexes and field overrides (including TTL), as firestore.indexes.json would say them,
//   - every file in the live Firebase Hosting release, plus its serving config (headers, rewrites).
//
// Usage: node scripts/live-state.mjs --out <dir> [--targets <firebase --only value>] [--updated-since <ISO time>]
//        node scripts/live-state.mjs --check-targets <firebase --only value>
// Needs GOOGLE_ACCESS_TOKEN with read access. Writes the files, manifest.json and checksums.txt
// (shasum format, the input for actions/attest).

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export const PROJECT = "always-on-time-zombit-2026";
export const HOSTING_SITE = PROJECT;
export const HOSTING_ORIGIN = `https://${HOSTING_SITE}.web.app`;
export const ALL_TARGETS = "functions,firestore,storage,hosting";

/** Maps a `firebase deploy --only` value to the kinds of artifacts that deploy can replace. */
export function selectTargets(only) {
  const selection = { functions: false, firestoreRules: false, firestoreIndexes: false, storageRules: false, hosting: false };
  for (const raw of (only ?? "").split(",")) {
    const target = raw.trim();
    if (!target) continue;
    const [service, detail] = target.split(/:(.*)/s);
    if (service === "functions") selection.functions = true;
    else if (service === "firestore") {
      if (!detail || detail === "rules") selection.firestoreRules = true;
      if (!detail || detail === "indexes") selection.firestoreIndexes = true;
      if (detail && !["rules", "indexes"].includes(detail)) throw new Error(`Unknown deploy target: ${target}`);
    } else if (service === "storage") selection.storageRules = true;
    else if (service === "hosting") selection.hosting = true;
    else throw new Error(`Unknown deploy target: ${target}`);
  }
  return selection;
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** JSON with sorted object keys, so the same settings always produce the same bytes. */
export function canonicalJson(value) {
  const sort = (v) => Array.isArray(v) ? v.map(sort)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(value), null, 2) + "\n";
}

async function google(token, url, init = {}) {
  const response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response;
}

async function pages(token, url, key, { pageSize = 100, mayBeUnreachable = [] } = {}) {
  const items = [];
  let pageToken = "";
  do {
    const params = [pageSize ? `pageSize=${pageSize}` : "", pageToken ? `pageToken=${encodeURIComponent(pageToken)}` : ""]
      .filter(Boolean).join("&");
    const page = await (await google(token, params ? url + (url.includes("?") ? "&" : "?") + params : url)).json();
    const unreachable = (page.unreachable ?? []).filter((location) => !mayBeUnreachable.includes(location.split("/").pop()));
    if (unreachable.length) throw new Error(`Some locations could not be listed: ${unreachable.join(", ")}`);
    items.push(...(page[key] ?? []));
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  return items;
}

export const listFunctions = (token) =>
  pages(token, `https://cloudfunctions.googleapis.com/v2/projects/${PROJECT}/locations/-/functions`, "functions");

// Restricted regions this project cannot use; Cloud Run always reports them unreachable. A service
// created in one would still show up as a deploy in the audit log check.
export const RESTRICTED_RUN_REGIONS = ["europe-west15", "me-central2", "us-central2", "us-east7", "us-west8"];

export const listRunServices = (token) =>
  pages(token, `https://run.googleapis.com/v2/projects/${PROJECT}/locations/-/services`, "services",
    { mayBeUnreachable: RESTRICTED_RUN_REGIONS });

/** The settings a deploy controls, without fields Google changes on its own (URLs, states, times). */
export function functionSettings(fn, invokers) {
  const build = fn.buildConfig ?? {};
  const service = fn.serviceConfig ?? {};
  const trigger = fn.eventTrigger;
  return {
    name: fn.name,
    environment: fn.environment,
    labels: fn.labels ?? {},
    build: { runtime: build.runtime, entryPoint: build.entryPoint, environmentVariables: build.environmentVariables ?? {} },
    service: {
      availableMemory: service.availableMemory,
      availableCpu: service.availableCpu,
      timeoutSeconds: service.timeoutSeconds,
      minInstanceCount: service.minInstanceCount ?? 0,
      maxInstanceCount: service.maxInstanceCount,
      maxInstanceRequestConcurrency: service.maxInstanceRequestConcurrency,
      ingressSettings: service.ingressSettings,
      serviceAccountEmail: service.serviceAccountEmail,
      environmentVariables: service.environmentVariables ?? {},
      secretEnvironmentVariables: (service.secretEnvironmentVariables ?? [])
        .map(({ key, secret, version }) => ({ key, secret, version }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      allTrafficOnLatestRevision: service.allTrafficOnLatestRevision,
    },
    trigger: trigger ? {
      eventType: trigger.eventType,
      eventFilters: (trigger.eventFilters ?? []).slice().sort((a, b) => a.attribute.localeCompare(b.attribute)),
      retryPolicy: trigger.retryPolicy,
      serviceAccountEmail: trigger.serviceAccountEmail,
    } : null,
    invokers: [...invokers].sort(),
  };
}

async function runInvokers(token, serviceName) {
  const policy = await (await google(token, `https://run.googleapis.com/v2/${serviceName}:getIamPolicy`)).json();
  return (policy.bindings ?? []).filter((b) => b.role === "roles/run.invoker").flatMap((b) => b.members);
}

async function functionArtifacts(token, fn) {
  const name = fn.name.split("/").pop();
  const source = fn.buildConfig?.source?.storageSource;
  if (!source?.bucket || !source?.object) throw new Error(`${fn.name} has no stored source archive`);
  const url = `https://storage.googleapis.com/storage/v1/b/${source.bucket}/o/${encodeURIComponent(source.object)}` +
    `?alt=media&generation=${source.generation}`;
  const zip = Buffer.from(await (await google(token, url)).arrayBuffer());
  const invokers = fn.serviceConfig?.service ? await runInvokers(token, fn.serviceConfig.service) : [];
  const settings = Buffer.from(canonicalJson(functionSettings(fn, invokers)));
  return [
    { kind: "function", name: `functions/${name}/function-source.zip`, file: `functions/${name}.zip`, bytes: zip },
    { kind: "function-settings", name: `functions/${name}/settings.json`, file: `functions/${name}.settings.json`, bytes: settings },
  ];
}

/** Repository file for each rules release; any other release has no source here and fails verification. */
export function rulesRepoPath(release) {
  if (release === "cloud.firestore") return "firestore.rules";
  if (release === `firebase.storage/${PROJECT}.firebasestorage.app`) return "storage.rules";
  return null;
}

async function rulesArtifacts(token, kind) {
  const releases = await pages(token, `https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases`, "releases");
  const artifacts = [];
  for (const release of releases) {
    const id = release.name.split("/releases/")[1];
    if ((kind === "firestore") !== id.startsWith("cloud.firestore")) continue;
    const ruleset = await (await google(token, `https://firebaserules.googleapis.com/v1/${release.rulesetName}`)).json();
    const files = ruleset.source?.files ?? [];
    if (files.length !== 1) throw new Error(`${id} ruleset has ${files.length} files; expected one`);
    artifacts.push({
      kind: "rules", name: `rules/${id}`, file: `rules/${id.replaceAll("/", "_")}.rules`,
      repoPath: rulesRepoPath(id), bytes: Buffer.from(files[0].content, "utf8"),
    });
  }
  return artifacts;
}

/** Normalizes firestore.indexes.json, or the live index state in the same shape, for comparison. */
export function normalizeIndexes({ indexes = [], fieldOverrides = [] }) {
  const field = (f) => ({ fieldPath: f.fieldPath, ...(f.order ? { order: f.order } : {}), ...(f.arrayConfig ? { arrayConfig: f.arrayConfig } : {}) });
  const key = (v) => JSON.stringify(v);
  return {
    indexes: indexes.map((i) => ({ collectionGroup: i.collectionGroup, queryScope: i.queryScope ?? "COLLECTION", fields: i.fields.map(field) }))
      .sort((a, b) => key(a).localeCompare(key(b))),
    fieldOverrides: fieldOverrides.map((o) => ({
      collectionGroup: o.collectionGroup, fieldPath: o.fieldPath, ttl: Boolean(o.ttl),
      indexes: (o.indexes ?? []).map((i) => ({ queryScope: i.queryScope ?? "COLLECTION", ...(i.order ? { order: i.order } : {}), ...(i.arrayConfig ? { arrayConfig: i.arrayConfig } : {}) }))
        .sort((a, b) => key(a).localeCompare(key(b))),
    })).sort((a, b) => key(a).localeCompare(key(b))),
  };
}

async function liveIndexes(token) {
  const base = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/collectionGroups/-`;
  // The Firestore admin list calls reject an explicit page size.
  const composite = await pages(token, `${base}/indexes`, "indexes", { pageSize: 0 });
  const overridden = await pages(token, `${base}/fields?filter=${encodeURIComponent("indexConfig.usesAncestorConfig:false")}`, "fields", { pageSize: 0 });
  const ttl = await pages(token, `${base}/fields?filter=${encodeURIComponent("ttlConfig:*")}`, "fields", { pageSize: 0 });
  const parts = (name) => ({ collectionGroup: name.split("/collectionGroups/")[1].split("/")[0], fieldPath: name.split("/fields/")[1] });
  const overrides = new Map();
  for (const f of [...overridden, ...ttl]) {
    const { collectionGroup, fieldPath } = parts(f.name);
    if (collectionGroup === "__default__") continue;
    const existing = overrides.get(f.name) ?? { collectionGroup, fieldPath, ttl: false, indexes: [] };
    if (f.ttlConfig) existing.ttl = true;
    // Each single-field index lists its one field with the order or array setting.
    if (f.indexConfig && !f.indexConfig.usesAncestorConfig) {
      existing.indexes = (f.indexConfig.indexes ?? []).map((i) => ({ queryScope: i.queryScope, ...i.fields?.[0], fieldPath: undefined }));
    }
    overrides.set(f.name, existing);
  }
  return normalizeIndexes({
    indexes: composite.map((i) => ({ collectionGroup: i.name.split("/collectionGroups/")[1].split("/")[0], queryScope: i.queryScope, fields: i.fields.filter((f) => f.fieldPath !== "__name__") })),
    fieldOverrides: [...overrides.values()],
  });
}

async function hostingArtifacts(token) {
  const base = "https://firebasehosting.googleapis.com/v1beta1";
  const { releases } = await (await google(token, `${base}/sites/${HOSTING_SITE}/channels/live/releases?pageSize=1`)).json();
  const version = releases?.[0]?.version;
  if (!version?.name) throw new Error("No live hosting release");
  const files = await pages(token, `${base}/${version.name}/files`, "files");
  const artifacts = [{
    kind: "hosting-config", name: "hosting/.serving-config.json", file: "hosting-config.json",
    bytes: Buffer.from(canonicalJson(version.config ?? {})),
  }];
  for (const file of files) {
    // /__/ is Firebase's reserved namespace (generated SDK config), not deployed content.
    if (file.path.startsWith("/__/")) continue;
    // Served bytes are what visitors get; fetch decodes any transfer compression.
    const response = await fetch(`${HOSTING_ORIGIN}${file.path}`, { cache: "no-store", redirect: "manual" });
    if (!response.ok) throw new Error(`${file.path} returned HTTP ${response.status}`);
    artifacts.push({
      kind: "hosting", name: `hosting${file.path}`, file: `hosting${file.path}`, repoPath: `account-web${file.path}`,
      bytes: Buffer.from(await response.arrayBuffer()),
    });
  }
  return artifacts;
}

/**
 * Collects the selected live artifacts. With `updatedSince`, only functions Google updated at or after
 * that time are included, so a deploy signs exactly what it changed.
 */
export async function collect(token, selection, { updatedSince } = {}) {
  const artifacts = [];
  if (selection.functions) {
    for (const fn of await listFunctions(token)) {
      if (updatedSince && Date.parse(fn.updateTime) < Date.parse(updatedSince)) continue;
      artifacts.push(...await functionArtifacts(token, fn));
    }
  }
  if (selection.firestoreRules) artifacts.push(...await rulesArtifacts(token, "firestore"));
  if (selection.storageRules) artifacts.push(...await rulesArtifacts(token, "storage"));
  if (selection.firestoreIndexes) {
    artifacts.push({
      kind: "indexes", name: "firestore/indexes.json", file: "firestore-indexes.json", repoPath: "firestore.indexes.json",
      bytes: Buffer.from(canonicalJson(await liveIndexes(token))),
    });
  }
  if (selection.hosting) artifacts.push(...await hostingArtifacts(token));
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    out: { type: "string" }, targets: { type: "string", default: ALL_TARGETS },
    "updated-since": { type: "string" }, "check-targets": { type: "string" },
  } });
  if (values["check-targets"] !== undefined) {
    selectTargets(values["check-targets"]);
    process.exit(0);
  }
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if (!values.out || !token) {
    console.error("Usage: GOOGLE_ACCESS_TOKEN=... node scripts/live-state.mjs --out <dir> [--targets <only>] [--updated-since <time>]");
    process.exit(2);
  }
  const artifacts = await collect(token, selectTargets(values.targets), { updatedSince: values["updated-since"] });
  for (const item of await writeArtifacts(values.out, artifacts)) console.log(`${item.sha256}  ${item.name}`);
}

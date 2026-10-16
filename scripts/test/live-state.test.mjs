import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, functionSettings, normalizeIndexes, rulesRepoPath, selectTargets } from "../live-state.mjs";

test("a full deploy selects every kind of signed artifact", () => {
  assert.deepEqual(selectTargets("functions,firestore,storage,hosting"),
    { functions: true, firestoreRules: true, firestoreIndexes: true, storageRules: true, hosting: true });
});

test("named functions, groups and codebases all select functions", () => {
  assert.equal(selectTargets("functions:calculateTravelRoute").functions, true);
  assert.equal(selectTargets("functions:default:deleteSyncedAccount").functions, true);
  assert.equal(selectTargets("functions:calculateTravelRoute").hosting, false);
});

test("Firestore rules and indexes can be deployed separately", () => {
  assert.deepEqual([selectTargets("firestore:indexes").firestoreRules, selectTargets("firestore:indexes").firestoreIndexes], [false, true]);
  assert.deepEqual([selectTargets("firestore:rules").firestoreRules, selectTargets("firestore:rules").firestoreIndexes], [true, false]);
});

test("unknown targets are refused before anything deploys", () => {
  assert.throws(() => selectTargets("database"), /Unknown deploy target/);
  assert.throws(() => selectTargets("firestore:everything"), /Unknown deploy target/);
});

test("only the two known rules releases map to repository files", () => {
  assert.equal(rulesRepoPath("cloud.firestore"), "firestore.rules");
  assert.equal(rulesRepoPath("firebase.storage/always-on-time-zombit-2026.firebasestorage.app"), "storage.rules");
  assert.equal(rulesRepoPath("firebase.storage/another-bucket"), null);
});

test("function settings ignore fields Google changes and keep what a deploy controls", () => {
  const fn = {
    name: "projects/p/locations/us-central1/functions/f", environment: "GEN_2", updateTime: "now", state: "ACTIVE", url: "https://x",
    buildConfig: { runtime: "nodejs22", entryPoint: "f" },
    serviceConfig: { availableMemory: "256Mi", ingressSettings: "ALLOW_ALL", revision: "f-00002", uri: "https://x",
      secretEnvironmentVariables: [{ key: "B", secret: "b", version: "2", projectId: "p" }, { key: "A", secret: "a", version: "1", projectId: "p" }] },
  };
  const settings = functionSettings(fn, ["allUsers"]);
  assert.equal(JSON.stringify(settings).includes("f-00002"), false);
  assert.equal(JSON.stringify(settings).includes("ACTIVE"), false);
  assert.deepEqual(settings.service.secretEnvironmentVariables.map((s) => s.key), ["A", "B"]);
  assert.deepEqual(settings.invokers, ["allUsers"]);
  assert.equal(canonicalJson(settings), canonicalJson(functionSettings({ ...fn, updateTime: "later" }, ["allUsers"])));
});

test("index normalization ignores ordering so live state compares with firestore.indexes.json", () => {
  const a = normalizeIndexes({ fieldOverrides: [
    { collectionGroup: "b", fieldPath: "t", ttl: true, indexes: [] },
    { collectionGroup: "a", fieldPath: "c", indexes: [{ order: "DESCENDING", queryScope: "COLLECTION" }, { order: "ASCENDING" }] },
  ] });
  const b = normalizeIndexes({ indexes: [], fieldOverrides: [
    { collectionGroup: "a", fieldPath: "c", indexes: [{ order: "ASCENDING", queryScope: "COLLECTION" }, { order: "DESCENDING" }] },
    { collectionGroup: "b", fieldPath: "t", ttl: true },
  ] });
  assert.equal(canonicalJson(a), canonicalJson(b));
});

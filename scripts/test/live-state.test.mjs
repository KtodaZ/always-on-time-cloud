import assert from "node:assert/strict";
import test from "node:test";

import { selectTargets } from "../live-state.mjs";

test("a full deploy selects every signed artifact", () => {
  const selection = selectTargets("functions,firestore,storage,hosting");
  assert.equal(selection.allFunctions, true);
  assert.equal(selection.firestoreRules, true);
  assert.equal(selection.storageRules, true);
  assert.equal(selection.hosting, true);
});

test("named functions select only those archives", () => {
  const selection = selectTargets("functions:calculateTravelRoute, functions:default:deleteSyncedAccount");
  assert.equal(selection.allFunctions, false);
  assert.deepEqual([...selection.functions].sort(), ["calculateTravelRoute", "deleteSyncedAccount"]);
  assert.equal(selection.hosting, false);
});

test("Firestore index deploys change no signed artifact", () => {
  const selection = selectTargets("firestore:indexes");
  assert.equal(selection.firestoreRules, false);
  assert.equal(selectTargets("firestore:rules").firestoreRules, true);
});

test("unknown targets are refused rather than silently unsigned", () => {
  assert.throws(() => selectTargets("database"), /Unknown deploy target/);
});

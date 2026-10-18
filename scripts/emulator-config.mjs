// Writes firebase.emulators.json: firebase.json with the Auth emulator's origin added to the consent
// page's Content-Security-Policy, so that page can sign in through the emulator in a browser. The
// production firebase.json never lists a local address.
//
// Usage: node scripts/emulator-config.mjs
//        npx firebase emulators:start --config firebase.emulators.json --only auth,firestore,functions,hosting --project demo-account-sync

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const AUTH_EMULATOR_ORIGIN = "http://127.0.0.1:9199";
const CONSENT_SOURCE = "/connect/**";

/** firebase.json with AUTH_EMULATOR_ORIGIN allowed in the consent page's connect-src and frame-src. */
export function emulatorConfig(config, origin = AUTH_EMULATOR_ORIGIN) {
  const copy = structuredClone(config);
  const rule = copy.hosting?.headers?.find((entry) => entry.source === CONSENT_SOURCE);
  const csp = rule?.headers.find((header) => header.key === "Content-Security-Policy");
  if (!csp) throw new Error(`firebase.json has no Content-Security-Policy for ${CONSENT_SOURCE}`);
  csp.value = csp.value.split(";").map((directive) => {
    const text = directive.trim();
    return /^(connect-src|frame-src)\s/.test(text) ? `${text} ${origin}` : text;
  }).join("; ");
  return copy;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL("../", import.meta.url);
  const config = JSON.parse(readFileSync(new URL("firebase.json", root), "utf8"));
  writeFileSync(new URL("firebase.emulators.json", root), JSON.stringify(emulatorConfig(config), null, 2) + "\n");
  console.log("Wrote firebase.emulators.json");
}

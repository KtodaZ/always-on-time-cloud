"use strict";

// Creates or resets the assistant review account (docs/ASSISTANT_CONNECTOR.md "Review account"):
// a Firebase Auth email and password user, its account marked active the way the app's account
// sync leaves it, and its alarm settings, activity and history back to the demo state. Existing
// assistant connections are kept. Prints only the account's uid, which is the ASSISTANT_DEMO_UID
// param. The password is read from REVIEW_ACCOUNT_PASSWORD or standard input and never printed.
//
// Usage (Admin SDK credentials from Application Default Credentials):
//   node scripts/seed-review-account.js --project <project id> --email <email> [--uid <uid>]
// Against the emulators, also set FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST.

const { createRequire } = require("node:module");
const path = require("node:path");
const { parseArgs } = require("node:util");

// firebase-admin and the connector code live in functions/.
const functionsRequire = createRequire(path.join(__dirname, "../functions/package.json"));
const { deleteApp, initializeApp } = functionsRequire("firebase-admin/app");
const { getAuth } = functionsRequire("firebase-admin/auth");
const { getFirestore } = functionsRequire("firebase-admin/firestore");
const { resetDemoAccount } = functionsRequire("./assistant-demo-phone");

const MIN_PASSWORD = 12;

/** The password from REVIEW_ACCOUNT_PASSWORD, else standard input (typed without echo on a terminal). */
async function readPassword() {
  if (process.env.REVIEW_ACCOUNT_PASSWORD) return process.env.REVIEW_ACCOUNT_PASSWORD;
  const input = process.stdin;
  if (!input.isTTY) {
    let text = "";
    for await (const chunk of input) text += chunk;
    return text.replace(/\r?\n$/, "");
  }
  process.stderr.write("Password: ");
  input.setRawMode(true);
  input.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let text = "";
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          input.setRawMode(false);
          reject(new Error("cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          input.setRawMode(false);
          input.pause();
          input.off("data", onData);
          process.stderr.write("\n");
          resolve(text);
          return;
        }
        text = char === "\u007f" ? text.slice(0, -1) : text + char;
      }
    };
    input.on("data", onData);
  });
}

/**
 * The review user, created or given this password. Refuses an existing user that signs in any
 * other way (a real person's account) or that has a different uid than `--uid`.
 */
async function upsertUser(auth, { email, password, uid }) {
  let user = null;
  try {
    user = await auth.getUserByEmail(email);
  } catch (error) {
    if (error.code !== "auth/user-not-found") throw error;
  }
  if (!user) return auth.createUser({ ...(uid ? { uid } : {}), email, password, emailVerified: true, displayName: "App review" });
  if (uid && user.uid !== uid) throw new Error(`${email} already belongs to another uid`);
  if (user.providerData.some((provider) => provider.providerId !== "password")) {
    throw new Error(`${email} already signs in another way (${user.providerData.map((provider) => provider.providerId).join(", ")}); use a separate address`);
  }
  return auth.updateUser(user.uid, { password, emailVerified: true, disabled: false });
}

async function main() {
  const { values } = parseArgs({ options: { project: { type: "string" }, email: { type: "string" }, uid: { type: "string" } } });
  const projectId = values.project ?? process.env.GCLOUD_PROJECT;
  if (!projectId || !values.email) throw new Error("usage: node scripts/seed-review-account.js --project <project id> --email <email> [--uid <uid>]");
  if (values.uid !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(values.uid)) throw new Error("--uid may use letters, digits, _ and - only");
  const password = await readPassword();
  if (password.length < MIN_PASSWORD) throw new Error(`the password needs at least ${MIN_PASSWORD} characters`);
  const app = initializeApp({ projectId });
  try {
    const user = await upsertUser(getAuth(app), { email: values.email, password, uid: values.uid });
    await resetDemoAccount(getFirestore(app), user.uid);
    process.stdout.write(`${user.uid}\n`);
  } finally {
    await deleteApp(app);
  }
}

main().catch((error) => {
  process.stderr.write(`seed-review-account: ${error.message}\n`);
  process.exit(1);
});

import { generateKeyPairSync } from "node:crypto";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A throwaway APNs signing key generated for each run; APNs itself is mocked in the tests.
const testApnsKey = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { APNS_AUTH_KEY_P8: testApnsKey },
      },
    }),
  ],
});

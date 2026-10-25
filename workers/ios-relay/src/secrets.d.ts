// Secrets set with `wrangler secret put` are not in wrangler.jsonc, so `wrangler types` omits them.
declare namespace Cloudflare {
  interface Env {
    APNS_AUTH_KEY_P8: string;
  }
}

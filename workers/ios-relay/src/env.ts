import type { ApnsTokenAuthority } from "./apns-token";
import type { InstallShard } from "./shard";

export interface Env {
  SHARDS: DurableObjectNamespace<InstallShard>;
  /** One object, `apns-provider-token`, holding the APNs provider token every shard shares. */
  APNS_TOKEN: DurableObjectNamespace<ApnsTokenAuthority>;
  /** Secret: APNs token-auth `.p8` key (EC P-256, PEM). */
  APNS_AUTH_KEY_P8: string;
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  APNS_TOPIC: string;
  /** "false" lets registration skip a missing App Check token (an invalid one is still refused). */
  ENFORCE_APP_CHECK: string;
  APP_CHECK_PROJECT_NUMBER: string;
  /** Comma-separated Firebase app IDs accepted as the App Check token subject. */
  APP_CHECK_APP_IDS: string;
  /** Outbound calls per shard alarm run; a positive integer string (default 40, Workers Free safe). */
  MAX_SUBREQUESTS_PER_RUN: string;
}

# Privacy policy

The published policy is <https://zombit.io/always-on-time/privacy/>, on the Zombit Studios
website, which maintains it. Play Console and the apps link to it.

The old address, `https://always-on-time-zombit-2026.web.app/privacy-policy.html`, redirects there
([`firebase.json`](../firebase.json) `redirects`), and browsers keep a `#section` from the old link.
Keep these section ids on the page: `#travel-location` (opened from every location privacy note in
the Android app), `#assistants` and `#usage-statistics`.

## Keeping it in step with this code

A change here that alters what data is collected, stored or forwarded, or how long it is kept,
needs the published policy updated to match before it ships, and Play's Data safety answers too if
it concerns data the app collects or shares. Say in the pull request where the policy was updated.

The routing dashboard retains anonymous daily totals of provider requests, errors and active
installations. These totals have no installation identifiers, coordinates, addresses or trip
details; the per-installation abuse counters still expire after about two days. The matching
disclosure is in the website policy's `#travel-location` section (effective October 23, 2026).

The iOS calendar refresh relay runs on Cloudflare (Workers and Durable Objects), so Cloudflare
processes and stores iPhone push data for us: the APNs device token, a hash of the install
secret, freshness settings (whether the phone polls iPhone calendars, active hours, time zone),
hashed alarm and subscription identifiers with their times, and push bookkeeping. It holds no
calendar content, and its logs record no IP addresses, request headers or tokens (Cloudflare still
sees the connecting IP address of each request to deliver it). The website policy must name Cloudflare as the processor of iPhone push tokens
before the iOS app launches ([protocol](IOS_PUSH_PROTOCOL.md)).

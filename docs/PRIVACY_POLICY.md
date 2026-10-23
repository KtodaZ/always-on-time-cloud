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

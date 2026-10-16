# Privacy policy

There is one published copy:
<https://always-on-time-zombit-2026.web.app/privacy-policy.html>. Play Console and the app link to
it. The Android app opens its `#travel-location` section from every location privacy note, so keep
that anchor.

## Files

- [`account-web/privacy-policy.html`](../account-web/privacy-policy.html): the published page,
  served by Firebase Hosting with the account deletion page.
- [`account-web/privacy-policy.md`](../account-web/privacy-policy.md): the same text in Markdown,
  for review in diffs. Keep the two word for word.

Play's Data safety answers live with the app's store listing and must agree with the policy.

## Updating it

1. Edit the HTML and the Markdown together, and set the effective date at the top of both to the
   day it goes live.
2. If the change is about data the app collects or shares, update the Data safety answers too.
3. Merge to `main`, then run the [Deploy workflow](DEPLOYING.md) with the `hosting` target.
4. Check the live page. The CDN can serve the old copy for a few minutes, so add a throwaway query
   to bypass it:

   ```sh
   curl -s "https://always-on-time-zombit-2026.web.app/privacy-policy.html?v=$(date +%s)" | grep "Effective date"
   ```

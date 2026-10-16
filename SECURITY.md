# Security policy

This repository runs the production backend for Always On Time, so security and privacy reports
are welcome and taken seriously.

## Reporting a vulnerability

Please report privately, not in a public issue:

- [Report a vulnerability](https://github.com/KtodaZ/always-on-time-cloud/security/advisories/new)
  through GitHub's private reporting, or
- email zombit.studios@gmail.com with "Security" in the subject.

Include what you found, how to reproduce it, and what data or access it affects. You can expect
an acknowledgement within a few days. Please give us a reasonable chance to fix an issue before
disclosing it, and do not access or change other people's data while testing; use the Firebase
emulators (see the [README](README.md#tests)) instead of production.

## Scope

In scope: the Cloud Functions, Firestore and Storage security rules, the hosted account pages, and
the deploy and verification workflows in this repository. Reports about the Android or iOS apps are
also welcome by email.

## Verifying what is deployed

Every production deploy is signed, and a daily public check confirms production still matches;
see [docs/DEPLOYING.md](docs/DEPLOYING.md#verifying-production).

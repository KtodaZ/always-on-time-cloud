# Contributing

Thanks for taking a look. This repository is the backend for a single app, so most changes come
from the maintainer, but issues and pull requests are welcome, especially anything that improves
privacy, security, or the clarity of what the code does with user data.

- **Security issues:** follow [SECURITY.md](SECURITY.md) instead of opening an issue.
- **Before a pull request:** run `npm ci && npm ci --prefix functions && npm test` and, for rules or
  account changes, the emulator tests in the [README](README.md#tests).
- **Data changes:** if a change alters what data is collected, stored, forwarded, or how long it is
  kept, the published [privacy policy](docs/PRIVACY_POLICY.md) must be updated to match before it
  ships; say so in the pull request.
- **Never commit secrets.** Keys and webhook URLs live in Secret Manager.
- Keep changes focused and match the surrounding style. Tests use Node's built-in test runner.

By contributing, you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE).

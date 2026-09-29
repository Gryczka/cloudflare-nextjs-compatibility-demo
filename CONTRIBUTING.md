# Contributing

Thanks for improving this reference sample. Contributions that make the three-fixture compatibility ladder or the separate fixed-template WfP contract more accurate, reproducible, or understandable are welcome.

## How to contribute

Fork the repository, create a focused branch, and open a pull request against `main`. Check existing [issues](../../issues) first so you can link a related discussion. Keep account-specific configuration, customer data, and credentials out of commits, screenshots, and logs.

## Development setup

```sh
git clone https://github.com/Gryczka/cloudflare-nextjs-compatibility-demo.git
cd cloudflare-nextjs-compatibility-demo
npm ci
npm run fixtures:install
npm run check
npm run fixtures:verify
```

Use Node.js 24. For the standalone-container fixture, use an unrestricted Docker daemon and run `VERIFY_CONTAINER=1 npm run fixtures:verify`. `npm run release:check` adds dependency audits; see [deployment setup](README.md#deploy-your-own-control-plane) before working with real Cloudflare resources.

## Code style

The app is TypeScript with Prettier formatting and Vitest tests. Run `npm run format:check`, `npm run typecheck`, and `npm test` before opening a pull request; `npm run check` runs all three. Use `npm run format` to format changed files. Add meaningful tests for changed behavior, especially ownership, quotas, retries, cleanup, and route validation. Document new public contracts and configuration in the README and example guide.

After changing `wrangler.jsonc` bindings, run `npm run cf-typegen` against the **public template**, not your ignored account-specific config. Do not commit production IDs or token values into `worker-configuration.d.ts`.

## Commit messages

Use a short, imperative subject that describes the change, such as `Document fixture fallback checks`. There is no required Conventional Commits prefix.

## Pull requests

Explain the behavior and motivation, link relevant issues, summarize checks run, and attach screenshots for UI changes. Reviewers look for reproducibility, correct fixture expectations, preservation of the fixed-template boundary, and regression coverage for stateful changes. CI-style checks should pass; builds needing a Cloudflare account must include clear verification instructions rather than credentials.

## Reporting bugs and requesting features

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) with fixture ID, expected/actual target, adapter versions, non-sensitive log excerpts, and reproduction steps. Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md) for a bounded change and describe its relationship to the existing example. For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

Please follow our [Code of Conduct](CODE_OF_CONDUCT.md). This is a best-effort reference repository; see [SUPPORT.md](SUPPORT.md) for support expectations.

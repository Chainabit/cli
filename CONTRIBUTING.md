# Contributing to the Chainabit CLI

Thank you for helping improve the Chainabit CLI! 🙌

## How this repository works

The Chainabit CLI **source code is private**. This public repository exists for:

- **Distribution** — releases are published to npm as the [`chainabit`](https://www.npmjs.com/package/chainabit) package.
- **Issue tracking** — bug reports and feature requests.
- **Changelog & releases** — the public history of what changed.

Because the source is private, we do **not** accept pull requests that modify
the CLI's behavior or code. We **do** welcome:

- High-quality bug reports
- Well-scoped feature requests
- Documentation/README fixes in this repository
- Reproductions that help us debug

## Filing a great bug report

Use the [bug report template](https://github.com/chainabit/cli/issues/new?template=bug_report.yml) and include:

1. CLI version — `chainabit --version`
2. Node.js version — `node --version`
3. Operating system
4. The exact command you ran (redact any tokens / secrets)
5. What you expected vs. what happened
6. Output with `--json` where relevant, or a screenshot

> ⚠️ **Never paste tokens, API keys, or secrets** into an issue. Redact values
> like `cbt_live_...`. See [SECURITY.md](./SECURITY.md) for vulnerability reports.

## Requesting a feature

Use the [feature request template](https://github.com/chainabit/cli/issues/new?template=feature_request.yml) and describe the problem you're trying to solve, not just the solution you have in mind.

## Documentation contributions

The user-facing documentation lives in the [chainabit-org/docs](https://github.com/chainabit/docs) repository and accepts pull requests. README fixes in this repository are also welcome.

## Code of Conduct

By participating you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

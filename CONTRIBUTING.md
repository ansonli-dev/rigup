# Contributing to Rigup

Thank you for helping improve Rigup. Read the [current validation status](docs/compatibility/status.md) before relying on an integration, and use [GitHub issues](https://github.com/ansonli-dev/rigup/issues) for reproducible bugs and feature proposals. Report vulnerabilities through [SECURITY.md](SECURITY.md), without publishing credentials or private project evidence.

## Local development

Use Node.js 24+, npm, Git, and a C compiler.

```sh
npm ci
npm run check
```

The complete check includes tests, type checking, compilation, local Markdown links, and a clean tarball-consumer lifecycle. It uses no paid models. See [development and testing](docs/guides/development.md) for focused tests and opt-in integrations.

## Changes and pull requests

1. Keep changes focused on an observable problem. Discuss broad behavior changes in an issue or draft PR before implementing them.
2. Reproduce a behavior bug with a failing test before fixing it. Add coverage for changed public behavior and update the relevant user documentation.
3. Preserve project ownership, preview binding, interrupted-run recovery, evidence provenance, cumulative budgets, and native SDD gates. Do not treat generated prose as source authority or successful configuration parsing as live compatibility.
4. Run `npm run check` and `npm audit`. Explain any checks you could not run and their required conditions. Do not mark skipped live tests as passed.
5. In the PR, describe the trigger, resulting behavior, validation, and limitations. Keep logs small and sanitized; retain enough source/version detail to reproduce a claim.

Follow existing TypeScript conventions and keep public APIs small. Avoid unrelated formatting, new dependencies without a concrete need, and generated files (`dist/`, caches, tarballs, machine-specific files). Use clear commit messages such as `fix: preserve user changes during update`.

Contributions are accepted under the [MIT License](LICENSE). Only contribute material you have the right to share. Be respectful in issues and reviews, discuss technical evidence, and keep private information private.

## Releases

Development preview downloads are distributed through [GitHub Releases](https://github.com/ansonli-dev/rigup/releases). The package stays private for registry publication. Maintainers can follow the [release checklist](docs/guides/development.md#release-checklist) to verify builds before publishing a tag.

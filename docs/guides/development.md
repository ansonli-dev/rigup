# Development and testing

## Prerequisites

Use Node.js 24+, npm, and Git. The default test suite requires child-process execution, local pipes, temporary directories, and Git repositories; a sandbox that denies these operations is not a supported test environment. Linux and macOS are the CI targets. Windows has not been validated; use a Linux environment for now.

```sh
npm ci
npm run check
```

`check` runs type checking, the Node test suite, compilation, local Markdown link validation, and a clean package-consumer lifecycle. The package checks use dependencies already cached by `npm ci` and install the tarball offline without lifecycle scripts. No model credentials, Docker, or paid requests are required. Tests create disposable fixtures outside the source tree.

Useful focused commands:

```sh
node --import tsx --test test/installer.test.ts test/recovery.test.ts
node --import tsx --test test/stage-context.test.ts test/host-context.test.ts
npm run typecheck
npm run build
npm run check:docs
npm run test:package
npm audit
```

## Architecture map

- `src/cli.ts`, `src/config.ts`, `src/onboarding.ts`: command parsing, effective settings, and interactive setup.
- `src/analyzer/`: read policy, source inventory, evidence, provider exchanges, and staged context.
- `src/generator/`: evidence-backed plans, artifact jobs, validation, and resumable caches.
- `src/installer/`: ownership/baselines, previews, three-way merges, locks, durable operations, recovery, and diagnosis.
- `src/integrations/`: native host/SDD bindings, pinned tools, custom skills and templates.
- `templates/scripts/`: standalone installed checks and OpenWiki CI support.
- `test/`: contract, package, recovery, and opt-in live integration tests.

Read [architecture](https://github.com/ansonli-dev/rigup/blob/main/docs/superpowers/specs/2026-11-02-rigup-design.md) for rationale; use actual tests and current validation status for implemented guarantees.

## Opt-in integrations

Live tests can install pinned tools, start native clients or local servers, and send billable model requests. Select a specific test and keep a fresh evidence directory; do not run every provider by default. Retain failed exchanges and durable budget ledgers when resuming. Never copy authentication files into fixtures or modify responses to make them pass.

Native Codex discovery and packaged-asset independence, without model turns:

```sh
RIGUP_LIVE=1 RIGUP_LIVE_EVIDENCE_DIR=/tmp/rigup-live-evidence \
  node --import tsx --test --test-name-pattern='live Codex native|live packaged assets' test/live-compatibility.test.ts
```

Protected pinned tool installation, CodeGraph interruption/recovery, and separate OpenWiki handoff:

```sh
RIGUP_LIVE_NATIVE=1 RIGUP_LIVE_CODEX=1 RIGUP_LIVE_EVIDENCE_DIR=/tmp/rigup-native-evidence \
  node --import tsx --test test/live-native-initialization.test.ts
```

This test uses native Codex MCP discovery, not wiki page generation. An optional real Codex/OpenSpec delivery-gate probe sends a model request:

```sh
RIGUP_LIVE=1 RIGUP_LIVE_GATE=1 RIGUP_OPENSPEC_BIN=/absolute/path/to/openspec \
  RIGUP_LIVE_EVIDENCE_DIR=/tmp/rigup-gate-evidence \
  node --import tsx --test --test-name-pattern='live Codex OpenSpec' test/live-compatibility.test.ts
```

The default-Codex semantic lifecycle probe is `test/live-codex-backend.test.ts`, gated by `RIGUP_LIVE_CODEX_BACKEND=1` and `RIGUP_OPENSPEC_BIN`. The real GitHub frontend workflow is `test/live-github-context.test.ts`; inspect its explicit source pins, workspace and budget before opting in. Existing results are linked from [validation status](../compatibility/status.md); an unchanged model adapter does not need another paid run solely for documentation changes.

## Release checklist

1. Review changes, compatibility claims, ownership/recovery behavior, dependency licenses, and the changelog.
2. Run `npm ci`, `npm run check`, `npm audit`, and the relevant opt-in tests. Scan source and Git history for secrets before a public push.
3. Inspect `npm pack --dry-run --json`; exclude fixtures, private exchanges, caches, and generated evidence. Run the package smoke from a clean source checkout.
4. Record exact tested commits and environments, and list externally blocked checks with prerequisites.
5. Push the reviewed source and verify CI. Tag or publish a registry release only after an explicit maintainer decision; remove `private: true` only as part of that separate release.

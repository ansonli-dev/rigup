# Development and testing

## Prerequisites

Use Node.js 24+, npm, Git, a C compiler, a POSIX shell, and `ps` (the `procps` package in minimal Debian containers). The default test suite requires child-process execution, local pipes, temporary directories, and Git repositories. Linux and macOS are the CI targets. Follow the [external validation handoff](external-validation-handoff.md) to test native Windows and WSL2 separately.

```sh
npm ci
npm run check
```

`check` runs type checking, the Node test suite, compilation, local Markdown link validation, and a clean package-consumer lifecycle. The package checks prefer cached dependencies and install the tarball without dependency lifecycle scripts. A cold cache may need public npm registry metadata even after `npm ci`; registry access is required in that case. No model credentials, Docker, or paid requests are required. Tests create disposable fixtures outside the source tree.

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

This test uses native Codex MCP discovery, not wiki page generation. It stops its own CodeGraph daemon through the pinned SDK with identity verification before deleting its fixture; uncertain shutdown retains the records and fails the test. The same flow has been exercised on macOS ARM64 and clean Linux ARM64 with Codex 0.166.0. Use an init/reaper in containers so detached native children are reaped. An optional real Codex/OpenSpec delivery-gate probe sends a model request:

```sh
RIGUP_LIVE=1 RIGUP_LIVE_GATE=1 RIGUP_OPENSPEC_BIN=/absolute/path/to/openspec \
  RIGUP_LIVE_EVIDENCE_DIR=/tmp/rigup-gate-evidence \
  node --import tsx --test --test-name-pattern='live Codex OpenSpec' test/live-compatibility.test.ts
```

The default-Codex semantic lifecycle probe is `test/live-codex-backend.test.ts`, gated by `RIGUP_LIVE_CODEX_BACKEND=1` and `RIGUP_OPENSPEC_BIN`. The real GitHub frontend workflow is `test/live-github-context.test.ts`; inspect its explicit source pins, workspace and budget before opting in. Existing results are linked from [validation status](../compatibility/status.md); an unchanged model adapter does not need another paid run solely for documentation changes.

For Claude on another machine, Windows preparation, actual report assertions, manual native gates and failure recovery, follow the [external validation handoff](external-validation-handoff.md). It distinguishes Claude OAuth from the Rigup research backend and does not require Codex for the Claude canary.

## Local GitLab validation

The GitLab live test requires an explicitly provisioned disposable local GitLab, an API token in a private file, and a GitLab Runner executable. It accepts loopback servers only, creates its own private project and shell runner, then deletes that project and stops its runner. It does not install a login service or register with an external project. Run it only against a disposable instance: the API token must be permitted to create projects and project runners.

```sh
RIGUP_LIVE_GITLAB=1 RIGUP_GITLAB_HOST=http://127.0.0.1:42880 \
  RIGUP_GITLAB_TOKEN_FILE=/private/path/to/local-test-token \
  RIGUP_GITLAB_RUNNER=/absolute/path/to/gitlab-runner \
  RIGUP_LIVE_EVIDENCE_DIR=/tmp/rigup-gitlab-evidence \
  node --import tsx --test test/live-gitlab.test.ts
```

The probe checks real include resolution and pipeline creation, successful snapshot checks, failure exit/JUnit artifact preservation, an actual push with the generated-wiki guard, and an actual source push missing its model credential. The last case intentionally fails the CI job with exit 3 and retains a pending report; it does not pretend a wiki was generated. Destroy the disposable server after testing and remove its temporary token.

Generated GitLab jobs use a regular stage from an explicit root `stages` list, or the default `test` stage for standalone configuration. Pipelines containing only `.pre`/`.post` jobs do not run. When external includes supply unknown stages, Rigup retains `.pre`; the existing included pipeline must contain a regular job, and the actual target/ref still needs server lint and runner verification. A root stage list containing only reserved stages requires a customer decision instead of silently changing their pipeline.

## Release checklist

Release packaging uses curl, tar, and standard shell utilities. On macOS, install Xcode Command Line Tools for `cc` and `codesign`. Build on the target operating system and architecture.

```sh
npm ci
npm run release:build -- --out-dir release-out
npm run release:check -- release-out/rigup-0.1.0-darwin-arm64.tar.gz
```

Adjust the archive name to your platform. Use a fresh output directory for another build. `node scripts/release/check-native.mjs` accepts the archive path and uses the public npm registry for the pinned tool smoke. It performs zero model requests.

1. Review changes, compatibility claims, ownership/recovery behavior, dependency licenses, and the changelog.
2. Run `npm ci`, `npm run check`, `npm audit`, and the relevant opt-in tests. Scan source and Git history for secrets before a public push.
3. Inspect `npm pack --dry-run --json`; exclude fixtures, private exchanges, caches, and generated evidence. Run the package smoke from a clean source checkout.
4. Record exact tested commits and environments, and list externally blocked checks with prerequisites.
5. Push the reviewed source and verify CI. Run the **Release** workflow by manual dispatch to build and check all four portable targets.
6. For an approved release, push a new `v<version>` tag at that commit matching `package.json`. The tag workflow rebuilds all four targets, validates the receipts and archive hashes, and publishes the verified development preview through GitHub Releases.
7. Check the published assets from an unauthenticated client. Keep published tags and bytes immutable. If an upload stops in a draft, inspect the matching run and rerun the failed publisher job with the original build artifacts. The publisher checks the draft's identity and completed uploads before resuming. Inspect unexpected assets or partial uploads before recovering the draft. A source fix for a published release needs a new version and tag.

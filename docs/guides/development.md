# Development and testing

Use Node.js 24, npm, Git, a C compiler, and POSIX tools including `ps`. Install Xcode Command Line Tools on macOS or `build-essential` and `procps` on a minimal Debian/Ubuntu system.

```sh
npm ci
npm run check
npm audit --audit-level=low
```

`check` runs type checking, tests, build, documentation links, and an isolated package install. A cold package cache may need registry access. Model requests require opt-in live tests.

## Architecture

- `src/cli.ts`, `src/onboarding.ts`, and `src/config.ts` handle the command, guide, and settings.
- `src/analyzer/` filters and scopes evidence. `src/generator/` prepares validated candidate assets.
- `src/installer/` handles preview, ownership, apply, and recovery. `src/integrations/` binds native entry points and pinned tools.
- `templates/` contains installed skills and standalone scripts. `scripts/release/` builds and verifies portable distributions.

## Opt-in integrations

Use a named scenario and a new private evidence directory. Read its limits before enabling model requests and retain usage across retries.

```sh
RIGUP_LIVE=1 RIGUP_LIVE_EVIDENCE_DIR=/tmp/rigup-discovery \
  node --import tsx --test --test-name-pattern='live Codex native|live packaged assets' test/live-compatibility.test.ts

RIGUP_LIVE_NATIVE=1 RIGUP_LIVE_CODEX=1 RIGUP_LIVE_EVIDENCE_DIR=/tmp/rigup-native \
  node --import tsx --test test/live-native-initialization.test.ts
```

These probes cover Codex discovery, packaged asset independence, and protected CodeGraph recovery with an OpenWiki handoff. They make zero model calls. Use an init/reaper in containers for detached native children.

The following scenarios send model requests. Select one and review its fixture, backend and budget in the source.

- `test/live-codex-backend.test.ts` uses `RIGUP_LIVE_CODEX_BACKEND=1` and `RIGUP_OPENSPEC_BIN` for the default Codex lifecycle.
- `test/live-compatibility.test.ts` uses `RIGUP_LIVE=1`, `RIGUP_LIVE_GATE=1` and `RIGUP_OPENSPEC_BIN` with `--test-name-pattern='live Codex OpenSpec'` for the delivery gate.
- `test/live-github-context.test.ts` uses `RIGUP_LIVE_BULLETPROOF_CONTEXT=1` for the pinned frontend scenario. Its budget and any required environment are defined in the test.

For Claude or Windows use the [handoff checklist](external-validation-handoff.md). For other clients, select the corresponding named test and verify its structured report. See the [tested scope](../compatibility/status.md).

## Local GitLab validation

Use a disposable loopback GitLab, a private API-token file with project and runner creation permissions, and a GitLab Runner executable.

```sh
RIGUP_LIVE_GITLAB=1 RIGUP_GITLAB_HOST=http://127.0.0.1:42880 \
  RIGUP_GITLAB_TOKEN_FILE=/private/path/to/local-test-token \
  RIGUP_GITLAB_RUNNER=/absolute/path/to/gitlab-runner \
  RIGUP_LIVE_EVIDENCE_DIR=/tmp/rigup-gitlab-evidence \
  node --import tsx --test test/live-gitlab.test.ts
```

The probe checks real include resolution, snapshot reports, failed checks, wiki push guards, and the missing-model pending report. Validate a target GitLab separately with its own permissions and runner.

## Release checklist

Build natively with curl and tar available. The example targets Apple Silicon. Use a fresh output directory and the corresponding archive name for another target.

```sh
npm run release:build -- --out-dir release-out
npm run release:check -- release-out/rigup-0.1.0-darwin-arm64.tar.gz
```

`node scripts/release/check-native.mjs ARCHIVE` checks the pinned tool setup using the public npm registry. It makes zero model calls.

1. Run the default checks and secret scan, inspect `npm pack --dry-run --json`, and update the changelog and support claims.
2. Verify CI on the release commit. Manually dispatch **Release** for a build-only check on all four targets.
3. For publication, push a new `v<version>` tag matching `package.json`. The tag workflow verifies the archives, receipts, and uploads before publishing the prerelease.
4. Download a published archive anonymously, verify its checksum, and run the extracted command. Advance the root `install.sh` URL to the verified release and check the public one-line command.
5. If publication stops at a draft, inspect it and rerun the failed publisher with the original build artifacts. Use a new version for changes to a published release.

## npm registry

Pack the reviewed source, inspect the file list, and test the archive in an isolated npm prefix. Sign in with `npm login --auth-type=web` and complete the registry's authentication prompts. Publish the exact archive to the public registry with `npm publish ./rigup-0.1.0.tgz --ignore-scripts --access public --tag latest`, using the version you checked. The `latest` tag lets users install with `npm install -g rigup`. Confirm the registry integrity and a clean global install before advertising a new version. [npm publishing](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)

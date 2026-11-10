# Development and testing

Use a supported Node.js version, npm, and Git. On macOS and Linux, use a C compiler and POSIX tools including `ps`. Install Xcode Command Line Tools on macOS or `build-essential` and `procps` on a minimal Debian/Ubuntu system.

```sh
npm ci
npm run check
npm audit --audit-level=low
```

`check` runs type checking, tests, build, documentation links, and an isolated package install. A cold package cache may need registry access. Model requests require opt-in live tests.

## Windows and agent sessions

Run the default checks in a fresh PowerShell 7 terminal with Git for Windows. Windows release tests pass absolute drive paths to `tar`. In Git Bash, GNU `tar` can read `C:\...` as a remote path. If you use Git Bash, put the directory containing Windows system `tar.exe` (`C:\Windows\System32`) first on `PATH` and check which `tar` resolves.

Use Node.js 22.19 or later in the 22.x line, or 24.2 or later. Record `node --version` with the results. To select another Node version in PowerShell, prepend its directory to a `PATH` built from the Machine and User values so Windows tools and Git remain available. Check `Get-Command tar.exe` after the change.

In a Claude Code or Codex terminal, provider and session variables can affect default tests, especially on older branches. Clear them in the test terminal. Keep live model probes in a separate configured terminal.

```powershell
Get-ChildItem Env: |
  Where-Object { $_.Name -match '^(ANTHROPIC|CLAUDE|CODEX|OPENAI)' } |
  ForEach-Object { Remove-Item "Env:$($_.Name)" }
node --version
npm ci
npm run check
```

Use `$env:TEMP` for Windows scratch paths. Git Bash's `/tmp` can resolve to a directory at a drive root. Keep test temp directories outside the source checkout. For an isolated HOME, use a private subdirectory under `%USERPROFILE%` because `%LOCALAPPDATA%` and drive roots can inherit extra group permissions. [Native Windows handoff notes](external-validation-handoff.md#w2-实测要点)

## Architecture

- `src/cli.ts`, `src/onboarding.ts`, and `src/config.ts` handle the command, guide, and settings.
- `src/analyzer/` filters and scopes evidence. `src/generator/` prepares validated candidate assets.
- `src/installer/` handles preview, ownership, apply, and recovery. `src/integrations/` binds native entry points and pinned tools.
- `templates/` contains installed skills and their references. `scripts/release/` builds and verifies portable distributions.

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
- `test/live-github-context.test.ts` uses `RIGUP_LIVE_BULLETPROOF_CONTEXT=1` and `RIGUP_LIVE_DDD_CONTEXT=1` for pinned React and DDD repositories. The cases verify scoped evidence, installed development rules, protected updates and the model budget against the packaged CLI.

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

The probe checks real include resolution, native JUnit reports, failed checks, wiki push guards, and the missing-model job failure. Validate a target GitLab separately with its own permissions and runner.

## Release checklist

Build natively with curl and tar available. The example targets Apple Silicon. Use a fresh output directory and the corresponding archive name for another target.

```sh
version=$(node -p 'require("./package.json").version')
npm run release:build -- --out-dir release-out
npm run release:check -- "release-out/rigup-$version-darwin-arm64.tar.gz"
```

`node scripts/release/check-native.mjs ARCHIVE` checks the pinned tool setup using the public npm registry. It makes zero model calls.

1. Update the version and lockfile with `npm version patch --no-git-tag-version` for a patch release. Update the changelog, run the default checks and secret scan, and inspect `npm pack --dry-run --json`.
2. Verify CI on the release commit. A manual **Release** dispatch builds and smoke-tests all four targets without publishing.
3. Set up npm Trusted Publishing before the first automated release. From the verified release commit on `main`, push a new tag matching `package.json`. [First-release setup](#npm-trusted-publishing)

   ```sh
   version=$(node -p 'require("./package.json").version')
   git tag -a "v$version" -m "Rigup v$version"
   git push origin "refs/tags/v$version"
   ```

4. **Release** verifies the four native builds, publishes the GitHub prerelease, and publishes the same verified `.tgz` to npm. Plain versions use `latest`. SemVer prereleases such as `0.2.0-rc.1` use `next`.
5. Compare `npm view "@ansonli.dev/rigup@$version" dist.integrity` with the npm integrity in `release-manifest.json`. Install that version in a clean npm prefix and run `rigup --version`. Download and verify a portable archive, then advance the root `install.sh` URL and check the one-line installer.

### npm Trusted Publishing

In GitHub **Settings → Environments**, create the `npm` environment with **Selected branches and tags**. Add a tag rule for `v*` so only release tags can use its publishing identity. Restrict creation and changes to release tags to maintainers if other contributors have write access. [GitHub environment settings](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)

A package maintainer sets up the GitHub Actions publisher under **Settings → Trusted publishing** on the npm package page. [Package settings entry point](https://www.npmjs.com/package/@ansonli.dev/rigup)

- **Organization or user** `ansonli-dev`
- **Repository** `rigup`
- **Workflow filename** `release.yml`
- **Environment name** `npm`
- **Allowed actions** enable direct publishing with `npm publish`

Create the binding when the first release tag is ready. npm expires a new binding if it has no successful publish within two days. The workflow uses short-lived OIDC credentials and npm provenance. [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)

### Recover a release

Inspect the GitHub draft or the failed npm job, correct the cause, and rerun the failed jobs for the same tag with `gh run rerun RUN_ID --failed` before the build artifacts expire. The publisher resumes a matching draft. The npm job accepts an existing version only when the published integrity matches the verified archive. Allow registry scanning to finish if the version was just accepted but is still unavailable publicly.

For npm authentication errors, check the four binding fields, direct publish access, and expiry. Replace an expired binding before rerunning. If the source or published bytes need to change, prepare a new version and tag.

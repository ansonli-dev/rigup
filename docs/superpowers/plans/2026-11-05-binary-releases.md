# Binary Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline. The user requests continuous execution, not another approval handoff.

**Goal:** Publish verified, source-independent Rigup command downloads on GitHub Releases.

**Architecture:** Keep the existing Node CLI/package intact inside portable archives, add a native executable launcher, and ship a verified installer with a tag-gated multi-platform release workflow.

**Tech Stack:** Node.js 24.22.2, C/POSIX, shell, Node test runner, GitHub Actions/gh.

**Spec:** docs/superpowers/specs/2026-11-05-binary-releases-design.md.

## Global Constraints

- Targets: darwin-arm64, darwin-x64, linux-arm64, linux-x64; canonical command `rigup init`.
- Bundle pinned Node.js 24.22.2 and production dependencies; preserve all license notices.
- No model calls, full OpenWiki initialization or existing budget changes. No registry publication; private:true stays.
- No overwrite of unrelated commands, existing tags/releases or unknown installation directories.
- User explicitly authorizes the requested GitHub release and normal commits/pushes; no force push.

## Review Focus

- Executable invoked through symlink, relocated under spaces/metacharacters, with EOF/SIGINT and no system Node/npm.
- Bundled worker/resource paths and post-install asset independence; failures must retain native operation identity.
- Corrupt/incomplete/unsafe archives, checksum mismatch, parallel/interrupted install and old-version rollback.
- Artifact/version/source/platform binding, partial matrix failure, reruns and least-privilege publication.
- Anonymous installation, package licenses, unsigned-platform claims and native Windows boundaries.

### Task 1: Build and exercise portable distributions

**Files:** scripts/release/launcher.c, scripts/release/runtime-lock.json, scripts/release/build.mjs, scripts/release/check.mjs, test/release.test.ts, package.json, .gitignore, THIRD_PARTY_NOTICES.md.

**Interfaces:** `buildRelease({outDir,target})` produces a versioned portable tar.gz, compiled npm tgz and target metadata; `checkRelease({archive})` runs an extracted actual executable and returns a structured receipt. Target metadata supplies version/source/runtime/hash/asset names to Task 3.

- [x] Write launcher tests for exact argv/cwd, bundled runtime selection and relocation; observe RED.
- [x] Implement the compiled launcher and locked official runtime/package assembly; exclude private/development files and preserve licenses.
- [x] Exercise native macOS release build, extracted lifecycle and standalone consumer with Node removed from PATH. Expected: credential-free pass, no clone/source lookup.
- [x] Exercise actual protected native tool flow against the portable CLI. Expected: CodeGraph query/init and no-op receipts, OpenWiki handoff only, no orphan writer/model turn.
- [x] Commit; task gate `npm run check` passes.

### Task 2: Safe installation and user documentation

**Files:** scripts/release/install.sh.in, scripts/release/installer.mjs, test/release-installer.test.ts, README.md, README.zh-CN.md, docs/guides/releases.md, docs/guides/development.md, docs/compatibility/status.md, CHANGELOG.md.

**Interfaces:** `renderInstaller({version})` returns the pinned-version installer. It consumes Task 1's archive layout/checksum contract and is shipped by Task 3. No change to project installation authority.

- [ ] Write real local HTTP fixture tests for checksum refusal, unrelated command protection, supported selection, version/path validation, install/repeat/upgrade and rollback retention; observe RED.
- [ ] Implement checksum-first staged installation, an owned atomic symlink update, no silent shell/profile changes, and explicit failure/cleanup behavior.
- [ ] Add download/install/verify/upgrade/rollback/uninstall instructions, runtime/license/platform limits, and Packages rationale. Use repository URLs for source-only evidence referenced by packaged guides.
- [ ] Commit; task gate `npm run check` and installer tests pass.

### Task 3: Multi-platform build, review and actual publication

**Files:** .github/workflows/release.yml, scripts/release/publish.mjs, test/release-publish.test.ts, docs/compatibility/evidence/2026-11-05-binary-releases/.

**Interfaces:** Publisher consumes exactly four validated target metadata/archives, one npm tgz and Task 2's installer. It outputs checksums, a release manifest, notes and the complete GitHub prerelease.

- [ ] Write publisher validation tests: version mismatch, missing/duplicate/mixed-source artifacts and partial-build publication rejected; observe RED.
- [ ] Implement pinned official Actions, read-only build jobs, build-only dispatch and version/tag-gated publisher; draft then publish only after complete validation.
- [ ] Run the four native runner builds and archive smokes; inspect real failures, fix root causes and preserve evidence.
- [ ] Obtain one fresh whole-change correctness/security/release review against the spec. Fix all locally actionable findings with RED/GREEN; keep precise external conditions.
- [ ] Run final default/package/release/installer/secret checks. Commit and push, verify main CI.
- [ ] Create the unused v0.1.0 tag without force after verifying its source/version. Observe the release workflow through publication; no draft-only handoff.
- [ ] Download the published asset anonymously, verify checksum and run a fresh extracted consumer smoke. Archive the release links, manifest/checksums, native results and all rulings; remove only this plan's scratch after task completion.

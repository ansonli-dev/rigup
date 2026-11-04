# Open source readiness implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The user requests continuous inline execution.

**Goal:** Ship a reviewed, reproducible source distribution with accurate open source documentation and no known locally actionable defects.

**Architecture:** Preserve the existing CLI and protected installation lifecycle. Add distribution checks and least-privilege CI around the same offline and real integration tests, with a current validation index separate from historical evidence.

**Tech Stack:** Node.js 24+, TypeScript, Node test runner, npm, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-05-open-source-readiness.md`.

## Global Constraints

- Default to Codex; do not reset existing model budgets or fabricate external credentials.
- OpenWiki long initialization remains a separate user task.
- Preserve user-authored documents and all historical test evidence.
- No npm publication or deployment. Commit and push are authorized.
- Reuse this isolated worktree. Every behavior fix needs a failing regression before implementation.

## Review Focus

- First-time source and tarball consumers: commands, included resources, links and bin permissions work without a developer checkout.
- Hostile project/config input: credentials, executable templates, symlinks and changed previews do not bypass existing protection.
- Platform and isolated environment differences: macOS success is not silently promoted to Linux, Windows or all provider support.
- Public repository exposure: evidence, package contents and full Git history contain no real credentials or unintended generated artifacts.
- Recovery and model boundaries: installed assets remain independent, failures retain state/budget, and docs distinguish observed behavior from human approval.

### Task 1: Complete the source distribution and contributor entry points

**Files:** README.md, README.zh-CN.md, docs/guides/, docs/README.md, CONTRIBUTING.md, SECURITY.md, LICENSE, CHANGELOG.md, package.json, package-lock.json, .gitignore, .github/, scripts/, test/packaging.test.ts, existing intended document renames.

**Interfaces:** Consumes the existing public CLI and npm pack contract. Produces `npm run check`, `npm run test:package`, linked source docs and credential-free CI used by Task 2.

- [x] Read the user document changes and primary Vite/GitHub CLI references; map missing user-facing content without changing implementation scope.
- [x] Add a real failing package-consumer check for required public resources and source-independent CLI operation. Run it and inspect the missing-resource failure.
- [x] Add the public documentation, MIT license, package metadata, CI, package smoke and local-link validation; preserve the existing manual in a guide and reconcile intended document renames.
- [x] Run package smoke and documentation checks. Expected: clean temporary install, help and tools-free init/preview/apply/doctor succeed without network/model credentials; source docs links resolve.
- [x] Commit the distribution/documentation changes.
- [x] Task gate: `npm run check` passes (tests, typecheck, build, docs and package smoke).

### Task 2: Close local validation gaps and audit the final branch

**Files:** Local fixes and their focused regressions as findings identify; docs/compatibility/status.md and docs/compatibility/evidence/2026-11-05-open-source/.

**Interfaces:** Consumes Task 1's repeatable check commands and the existing live test entry points. Produces a current evidence index, explicit external prerequisites and a reviewed push candidate.

- [x] Audit production/development dependencies and Git history for secrets. Inspect existing pending states against current evidence; investigate locally reproducible gaps rather than copying old pending labels.
- [x] Run available real Codex discovery/gates, packaged assets, native tools/CodeGraph recovery and Linux checks where practical. Reuse verified fixtures, record actual versions, costs and commands. Do not repeat unchanged paid semantic generation solely to refresh a date.
- [x] For each discovered defect, record reproduction and write a regression; observe RED, implement the smallest root-cause fix, observe GREEN. Run the relevant complete suite after changes.
- [x] Update the current support/validation index and prerequisite/resume instructions. Preserve historical failures and tested-source attribution.
- [x] Commit fixes and evidence.
- [x] Task gate: `npm run check` passes, dependency audit has no unmitigated locally fixable vulnerability, secret scan has no real credential finding.

### Task 3: Final review, verification and remote delivery

**Files:** Final review/fix evidence in docs/compatibility/evidence/2026-11-05-open-source/ and any regression-required fixes.

**Interfaces:** Consumes Task 2's clean candidate. Produces a verified commit on the authorized GitHub remote and a concise final handoff.

- [x] Build the whole-branch review package from 0214ffdb147e5747361fe796b8e1f09422793dc8; request one fresh complete correctness/security/distribution review using the required reviewer template and this Review Focus.
- [x] Re-grade findings by user effect; resolve locally actionable findings in the single fix pass with RED→GREEN and a green suite. Explicitly rule on every declined judgment. The user's request to close local issues takes precedence over deferring cheap local polish merely because it is minor.
- [x] Archive review, decisions and final checks, commit; verify clean source except ignored personal OS files.
- [x] Verify the remote refs. Push without force, initializing main if the remote remains empty; otherwise preserve existing remote history. Do not modify another checked-out local main.
- [x] Observe GitHub CI and fix failures if the service can run them. Record any account/service restriction precisely.
- [x] Archive the final record and remove only this plan's scratch directory. Report the remote commit, checks and external-only follow-up conditions.

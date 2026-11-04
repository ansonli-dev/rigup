# Context Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline. The user explicitly authorized continuous implementation and rerunning the real E2E without confirmation.

**Goal:** Complete Bulletproof React semantic E2E within the unchanged 12-request / 1200000-token budget by removing complete dependency lockfiles from repeated Codex evidence payloads.

**Architecture:** Keep the full repository inventory and fingerprint. An explicit, versioned Codex export policy omits known dependency lockfile bodies, reports omissions and preserves manifest/source evidence. Bind the policy to request and accepted-result identity; preserve durable accounting. Manual host exchange retains its current default behavior.

**Tech Stack:** TypeScript, Node 24, node:test, Codex 0.166.0, OpenSpec 1.16.0.

**Spec:** User request 2026-11-05; `docs/superpowers/specs/scaffold-modules/01-project-analyzer.md` (bounded reading, evidence/unknowns, scope and source reuse); `docs/compatibility/evidence/2026-11-05-github-projects/frontend-semantic-failure.json` (measured failing case).

## Global Constraints

- Reuse the existing `codex/rigup-implementation` worktree; preserve unrelated user drafts and prior failure evidence.
- Same upstream commit `9506629ed003a561c6627735480cce4994244bb4`, same research scope, Codex default backend, OpenSpec enabled, maxCalls=12 and maxTokens=1200000.
- Do not disable semantic generation, fabricate/modify model responses, increase the budget, or erase charged attempts to obtain a pass.
- Keep all source/authority/counterexample evidence except explicitly omitted dependency lock bodies; expose the omission and do not imply exact locked versions were checked.
- Preserve OpenWiki manual initialization, CodeGraph protected initialization/recovery, private context, evidence validation and durable usage.

## Review Focus

- A changed export policy must not reuse incompatible request or acceptance provenance.
- Omitting lock bodies must not hide source changes from fingerprints or drop handwritten similarly named files.
- Recovery must retain failed/unknown charges and refuse exhausted budgets.
- Filtered evidence, native gates and source/counterexample paths must remain available.
- Real E2E must retain the same scope and budget and preserve original upstream files; no no-SDD shortcut.

### Task 1: Protected dependency-context export

**Files:** `src/analyzer/{host,codex}.ts`, `test/host-context.test.ts`, `test/codex-backend.test.ts`.

**Interfaces:** `hostBackend({cacheRoot,responsePath?,requestPath?,omitDependencyLocks?})` adds an explicit policy bound into its request context. Pending exports retain `paths` as full inventory, expose `omittedEvidence`, and contain evidence bodies only for the selected paths. `codexBackend` uses this policy in export and import, increments its adapter version, and leaves its durable ledger key unchanged.

- [x] Write failing real-filesystem tests for absent lock bodies, retained manifests/source/handwritten names, all request stages, policy-separated request IDs, tampered omissions, accepted-result reuse, and real Codex prompt wiring. Run focused tests; expected failure because all bodies are exported today.
- [x] Implement the closed lockfile policy for package-lock.json, npm-shrinkwrap.json, yarn.lock, pnpm-lock.yaml, bun.lock and bun.lockb. Preserve reader permissions and fingerprints. Run focused tests and typecheck; expected pass.
- [x] Run `npm test`, typecheck/build and pack; expected no failures and no test/customer state in the package. Commit the policy and tests.

### Task 2: Real semantic E2E under the same budget

**Files:** opt-in `test/live-github-context.test.ts` and focused support as needed; compatibility verification, README and new evidence directory.

**Interfaces:** Consumes the installed real npm package and Task 1 context policy. Produces a fresh pinned Bulletproof React run with durable reports, actual usage and per-stage payload measurements, plus unchanged update/local edit/native-host/application checks.

- [x] Create a clean clone of the same upstream commit and identical options/budget; reuse local dependency/browser downloads where possible. Keep the prior failed run intact.
- [x] Run the real packaged CLI with Codex default, OpenSpec and both tools. Verify research/planning and all planned content/acceptance stages, independent preview/apply, actual source query, no OpenWiki native initialization, unchanged update and local edit protection. Assert actual usage <=12 / 1200000 and absence of complete lock bodies in every request.
- [x] Recheck original source/native gates and application build, 21 Vitest and 3 browser cases. Archive actual stage/usage/payload evidence and retained historical failure.
- [x] Run the full local suite/typecheck/build/pack and one fresh final review. Fix Important/Critical findings once with RED→GREEN tests, archive rulings, remove only this plan's scratch workspace and retain the branch/worktree without merge/push.

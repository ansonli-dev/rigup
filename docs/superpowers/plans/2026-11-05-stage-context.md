# Stage Context Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline with TDD. The user explicitly requests continuous implementation and real default-Codex E2E without intermediate confirmation.

**Goal:** Send task-specific evidence in plan/content/acceptance and pass the same pinned Bulletproof React semantic E2E within 12 requests / 1200000 observed tokens.

**Architecture:** Keep analyze's bounded non-lock source scan and full inventory/fingerprint. A versioned Codex policy projects subsequent inputs and selects exact cited ranges plus task seed files, related-job closure, applicable instructions/native gates/manifests, and acceptance candidate links. Omitted bodies are explicit. Original-input digests, selection and policy bind request identity; Codex's root/run durable accounting remains unchanged.

**Tech Stack:** TypeScript, Node 24, node:test, installed npm package, default Codex, OpenSpec 1.16.0.

**Spec:** Latest user request; `docs/superpowers/specs/scaffold-modules/01-project-analyzer.md` (source/gap research, counterexamples, bounded reading, fingerprint and authority); prior `docs/compatibility/evidence/2026-11-05-context-budget/` measured baseline.

## Global Constraints

- Reuse `codex/rigup-implementation`; preserve user drafts and all historical runs/consumption. No push/merge.
- Same upstream `9506629ed003a561c6627735480cce4994244bb4`, same scope/config, Codex default and OpenSpec enabled, maxCalls=12/maxTokens=1200000. No replacement backend, altered model result, disabled SDD, or charge reset.
- Preserve full inventory and source fingerprints; dependency lock bodies stay omitted. No arbitrary file caps that silently discard needed evidence.
- Preserve current-job support/counterexamples, applicable explicit authority, conflicting/unavailable guidance and unknowns, related-artifact cycles, and native gates. Unselected bodies are unavailable, not proof of absence.
- Keep manual host defaults, read/privacy policy, validated Evidence, source and user-edit protection. OpenWiki remains manual; CodeGraph protected initialization/recovery remains intact.

## Review Focus

- Selection/projection or candidate changes must invalidate incompatible cached requests while adapter upgrades preserve known/unknown consumption.
- Current-job evidence must include counterexamples and unresolved authority rather than matching only positive seed files or prose keywords.
- Exact ranges must retain visible line numbers/digests; invalid paths, missing sources and tampered selection must not become accepted evidence.
- Related jobs can form cycles; candidate links must resolve within allowed inventory without reading generated baselines as authority.
- Real E2E must run all four semantic stages, retain identical scope/budget, materially reduce later-stage evidence and preserve original/native files.

### Task 1: Protected stage evidence and input projection

**Files:** new `src/analyzer/stage-context.ts`; modify `src/analyzer/{host,codex}.ts`; new `test/stage-context.test.ts`; extend `test/codex-backend.test.ts`.

**Interfaces:** Pure `stageContext(request:ResearchRequest, paths:string[])` returns projected input, deterministic file/range selection and unavailable-source notes. A separate materializer reads only that selection through RepositoryReader, verifies cited digests and deduplicates exact snippets. `hostBackend({stageEvidence?:boolean})` binds `stage-evidence-v1`, original input digest and selection to context/cache/provenance. Codex adapter 3 opts in, using a versioned exchange directory while retaining the existing durable ledger key.

- [x] Write real-filesystem failing tests for: analyze unchanged scan; plan cited ranges instead of unreferenced bodies; current job + same-topic counterexamples/conflicts/native gates, unrelated research removed; cyclic related jobs; acceptance relative links; missing/outside/lock paths; exact digest/range validation; identity separation, original-input digest and tampered-selection rejection; actual Codex prompt and upgrade accounting. Run focused tests; expected failures on current full-project exports.
- [x] Implement pure projection, range materialization, explicit omissions, selected snapshots and strict import verification. Keep stage-only fields out of shared host runContext. Bump only Codex adapter, not lifecycle consent/prompt versions. Run focused tests and typecheck; expected all pass.
- [x] Run full local suite, build and pack; expected no failures and no tests/customer state in package. Commit implementation and verification evidence.

### Task 2: Real staged-context E2E and evidence

**Files:** extend `test/live-github-context.test.ts`; new `docs/compatibility/evidence/2026-11-05-stage-context/`; README and compatibility verification.

**Interfaces:** Consumes the real installed package from Task 1. Produces per-stage payload/evidence measurements, actual ledger, source/native audit and real application/native-host checks. All attempts in the new authorized case remain charged and historical evidence stays immutable.

- [ ] Prepare a fresh pinned clone, official OpenSpec and identical options. Reuse unchanged frozen dependencies/browser downloads. Extend live test assertions for policy, current-job source/gates, exact snippets and later-stage evidence <=65% of analyze. Run real installed CLI with default Codex, independent apply, unchanged update and user-note protection; expected all pass within 12/1200000.
- [ ] Recheck source/native preservation, actual Codex MCP query, app build, 21 Vitest and 3 original Chromium cases. Stop test services. Archive actual measurements, tokens and comparison with the preserved prior round.
- [ ] Run typecheck/build/full suite/pack, commit evidence, use task-done. Perform one fresh final review; fix Critical/Important once with RED→GREEN and full green suite, archive rulings, delete only this plan's scratch, retain branch/worktree.

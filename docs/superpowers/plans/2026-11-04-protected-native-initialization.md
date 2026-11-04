# Protected Native Initialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete protected OpenWiki/CodeGraph initialization and recovery, using Codex for the credential-free mainline.

**Architecture:** Closed, pinned native adapters separate software installation, host registration, and project initialization. Durable intent precedes external writes, state queries reconcile interrupted work, and existing user state is preserved. Native commands and their complete write boundaries are verified from locked upstream artifacts before enabling them.

**Tech Stack:** TypeScript, Node.js, node:test, pinned OpenWiki 0.7.3 and CodeGraph 1.6.2, Codex.

**Spec:** `docs/superpowers/specs/scaffold-modules/04-integrations.md`, `docs/superpowers/specs/scaffold-modules/03-rigup-installer.md`; user instruction 2026-11-04 explicitly authorizes environment/dependency setup and continuous implementation, with Codex as default and alternate hosts/models deferred.

## Global Constraints

- Software installation, host registration, and initialization remain separate operations.
- Only official native entry points write tool databases, Claims, or indexes.
- Declared writes do not authorize overwriting existing user content; reject symlinks, scope escapes, stale previews, and candidate overlaps.
- Persist intent before dispatch; confirm prior writers exited before recovery; never blindly repeat an ambiguous external write.
- Reuse the existing isolated `codex/rigup-implementation` worktree. Preserve unrelated user drafts.
- Codex is the default available agent. Claude, alternate hosts, and model switching are deferred by the user. No external API credential is required for deterministic initialization.

## Review Focus

- Interrupted initialization with partial native state: resume through a verified native entry point without erasing user data.
- Scope changes and symlink ancestors between preview and dispatch: no writes outside the authorized project scope.
- Installation plus initialization in one apply: dependencies execute once and their distinct receipts survive restart/cache loss.
- Pre-existing native configuration and documentation: no overwrite or false ownership claim.
- Native source indexing and generated state: queries reflect project code while generated state does not contaminate semantic research.

### Task 1: Verified protected native adapters

**Files:** `src/types.ts`, `src/integrations/tools/{openwiki,codegraph,initialization}.ts`, `src/integrations/registry.ts`, `test/native-initialization.test.ts`, compatibility source evidence.

**Interfaces:** Consumes `SetupOptions.tools`, pinned upstream recipes and installed package receipts. Produces a closed `SetupOperation` initialization recipe plus an actual native-state query; existing software-install recipes remain valid.

- [ ] Inspect exact pinned artifacts, recording entry points, write scopes, disabled hooks/daemon behavior, and native recovery semantics.
- [ ] Write failing behavioral tests for initialization planning, existing user state, unsafe scopes, and non-Codex defaults. Run `node --import tsx --test test/native-initialization.test.ts`; expected FAIL because initialization is manual today.
- [ ] Implement pinned adapters and planning with safe preconditions and explicit prerequisites. Native outputs are queried rather than fabricated.
- [ ] Run the focused tests and `npm run typecheck`; expected PASS. Commit `feat: plan protected native tool initialization`.

### Task 2: Durable initialization execution and recovery

**Files:** `src/installer/{operations,preview,apply,state}.ts`, new focused native runtime modules, `src/integrations/tools/initialization.ts`, `src/analyzer/*` if generated state needs projection, `test/native-initialization.test.ts`, installer tests.

**Interfaces:** Consumes Task 1 operations and native-state queries. Produces distinct durable initialization receipts, dependency-aware execution and resumable recovery bound to the approved preview.

- [ ] Add failing tests for installation plus initialization, partial/interrupted state, cache deletion, writer liveness, stale previews, source edits, and preserved existing content. Run the relevant focused tests; expected FAIL for missing initialization dispatch/reconciliation.
- [ ] Implement closed native dispatch with protected state promotion or verified narrow native write scopes, durable process identity and intent, and native recovery after writer death. Preserve software receipts independently of initialization receipts.
- [ ] Run `npm test` and `npm run typecheck`; expected no failures. Commit `feat: execute and recover protected native initialization`.

### Task 3: Codex mainline acceptance and evidence

**Files:** `test/live-tools.test.ts`, `test/live-compatibility.test.ts` and support as needed; `src/cli.ts` and defaults as needed; `docs/compatibility/{verification.md,upstream-lock.json,evidence/2026-11-04-native-initialization/*}`.

**Interfaces:** Consumes Task 2 public preview/apply path. Produces repeatable real pinned-tool initialization/recovery/query proof and Codex host registration proof, with truthful remaining external requirements.

- [ ] Add failing acceptance cases for public mainline initialization/recovery and Codex default selection. Run focused cases; expected FAIL before the missing behavior exists.
- [ ] Install required pinned tools in private temporary environments and exercise official native initialization and recovery against disposable projects. Use Codex only for host acceptance; no alternate model/host probes.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, appropriate Codex/native live tests and `npm pack --dry-run`; expected no failures and no scratch/customer state in the package. Archive evidence and commit `test: verify Codex native initialization and recovery`.
- [ ] Run one fresh-context whole-change review as required by executing-plans. Re-grade findings, fix Important/Critical findings in one RED→GREEN pass, run the suite, archive rulings and remove only this plan's scratch workspace. Keep the branch for review without merge/push.

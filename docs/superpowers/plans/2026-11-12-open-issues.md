# Resolve all open issues Implementation Plan

> **For agentic workers:** Use superpowers:test-driven-development for each behavior slice, superpowers:dispatching-parallel-agents only for disjoint ownership below, and superpowers:requesting-code-review plus verification-before-completion before integration. Execute continuously after this plan's independent review gates.

**Goal:** Resolve issues #45–#54 together, verify Codex/OpenCode/oh-my-pi on macOS/Windows/Linux, then upgrade, merge and publish.
**Architecture:** Extend the existing native workflow, installer and provider loop; one runtime-input module concentrates declarations, private values and summaries. Preserve current ownership, native gates, read policy and usage accounting.
**Tech Stack:** TypeScript, Node.js `^22.19.0 || >=24.2.0`, node:test/tsx, pinned existing SDKs, Git, existing host CLIs and release workflows.
**Spec:** [Reviewed design](../specs/2026-11-12-open-issues-design.md), SHA256 `b1b8d2db3239b074715e7743f547f7daac6abda7e7fa505c047daa5084bcc523`; [issue requirements/comments](../specs/2026-11-12-open-issues.md).

## Global constraints

- User authorized one continuous integrated repair, dependency/environment setup, version upgrade, merge and publication after all required gates. Claude real-host verification is the user's external task.
- Baseline `20c67fe90b1c88400f076fe5d445821d0fb771f7`; repair branch `codex/resolve-open-issues`. Preserve all other worktrees and original uncommitted documents.
- Design and plan each require at least two independent full review rounds; fix confirmed findings until a complete final snapshot is clean. Do not implement before the plan gate.
- Use exact immutable target digests/modes for approval, races and recovery. Text equivalence affects owned-content decisions only.
- Only declared credentials reach selected consumers; no values in previews, generated tracked assets, reports, baselines or journals. Host/CI presence is not local verification.
- No new general workflow/adapter framework or package dependency. Reuse native artifact locations, existing checks, safe paths, locks and recipe integrity.
- Keep per-attempt bounded native model probes and actual usage evidence. Unexpected skips/pending are incomplete gates; do not claim emulation or stubs prove native behavior.
- No force push, discarded local work, fabricated external evidence, or failed-gate publication.

## Review focus

1. Adopt only matching unknown content; preserve actual edits, permissions and outside-selector bytes after CRLF checkout (Tasks 4,5).
2. Keep .env private, ignored, race-safe and excluded from persisted command/results even when child failure echoes a secret (Task 2).
3. Check both ordinary apply and separate OpenSpec preparation before any mode-sensitive write; preserve interrupted transactions (Task 5).
4. Repair provider failures under the original budget/read authority and fail closed for unknown usage (Task 3).
5. Prove latest SHA and selected executable identity, including actual native hosts and post-merge CI (Tasks 1,4,7,8).

## Ownership and sequencing

After the plan gate, Tasks 1,2,3 may run concurrently in disjoint files; the coordinator handles Tasks 4,5,6 and all shared integration edits. One agent owns each file at a time. Cross-task interfaces below are frozen before dispatch; request an explicit file handoff for shared edits. Do not commit another worker's incomplete files. Tests and checks are rerun after integration, not only in isolated domains.

- Workflow owner: workflow templates, render.ts, fixed-entry collision modules, workflow fixture support/tests.
- Runtime owner: new runtime module, config/types/CLI/lifecycle/provider-selection integration, quality/check runner, npm/OpenSpec runtime hooks. Parent owns shared installer/apply/doctor and registry edits requested via messages.
- Provider owner: provider-loop/anthropic/openai-compatible/provider-settings metadata and cap; evidence/backend typed failures, provider tests. Runtime coordinates settings/lifecycle calls; parent owns repository.ts discovery call.
- Coordinator: discovery, launch/version, ownership/merge/preview/apply/doctor, filesystem preflight, Windows GitLab probe, shared guides/changelog, integration/release.

## Task 1: GOAL, readiness and current-head delivery (#45)

**Files:** templates/skills/change-{prepare,ready,deliver}/**; src/generator/render.ts; src/integrations/custom-skills.ts and custom-templates.ts; a small shared fixed-entry list only if it replaces duplicate current lists; test/skills.test.ts; new test/workflow-fixture.test.ts and test/live-workflow.test.ts/support.
**Interfaces:** renderFixed installs ready alongside prepare/deliver and a fixed GOAL template at change-prepare/references/GOAL.md; native bindings remain source of entry paths, split artifacts and prerequisites. No new public CLI workflow executor.

- [x] Add a failing generation/collision regression: installed ready references resolve for every selected host and a customer skill cannot shadow ready. Run `node --import tsx --test test/skills.test.ts`; expected missing ready/collision assertion fails.
- [x] Extend fixed template generation and existing collision validation minimally.
- [x] Add fixed GOAL content and prepare/ready/deliver contracts from design §A; include native artifact review, coordinated revisions, all native prerequisites, concrete copyable repo-relative /goal, outgoing commit review and configured MR head loop.
- [x] Run focused generation/skills checks; expected all pass, including legacy workflow bindings and mandatory gates.
- [x] Implement a disposable loopback GitLab-like fixture supplying configured MR/CI/reviewer signals and a real local Git remote. Test fixture safety/state independently: old SHA green, failed required check, reviewer pending with no comments, finding unresolved, head changed during completion all fail completion; current SHA passing checks + completed configured review + recorded dispositions succeeds.
- [x] Add opt-in native-host scenarios that consume actual generated skills and the fixture: incomplete OpenSpec native state, split Spec/Plan reference to another change, missing acceptance verification, unverifiable goal, loaded-skill bypass request, ready command with exact path, approved implementation + pre-push review + finding fix/test/local push/current-head follow-up. Keep no-skill enforcement boundary explicit. Actual host runs occur in Task 7.
- [x] Run `node --import tsx --test test/skills.test.ts test/generator.test.ts test/workflow-fixture.test.ts`; expected zero failures. Record fixture evidence separately from native agent evidence.

## Task 2: Declared runtime values, private template and summary (#46)

**Files:** new src/runtime-inputs.ts (split private dotenv code only if cohesive size requires); src/config.ts, types.ts, cli.ts, lifecycle.ts; src/integrations/tools/quality.ts and project-check.mjs; src/integrations/tools/recipes.ts/software.ts, installer/operations.ts, integrations/sdd/openspec-setup.ts; test/runtime-inputs.test.ts, runtime-command.test.ts, registry-selection.test.ts, provider-cli.test.ts, openspec-setup.test.ts, native-initialization.test.ts and doctor.test.ts. Parent wires registry/apply/doctor.
**Interfaces:**
- `runtimeSetupSummary(root:string, options:SetupOptions, evidence?:{configured?:string[];verified?:string[]}):Promise<RuntimeSetupSummary>`.
- `applyRuntimeInputs(root:string, options:SetupOptions, evidence?):Promise<RuntimeSetupSummary>`, called lock-held after mode preflight and managed ignore verification.
- `runtimeEnvironment(root:string, options:SetupOptions, consumer:'provider'|'npm'|`customer:${string}`):Promise<NodeJS.ProcessEnv>`, only essential system + declared selected values.
- Summary exposes inputs `{name,capability,destination,required,state,source?,reason}`, template state/needsUpdate/imported names and per-capability configuration/verification; no values.
- Provider selection stays in provider-settings.ts: expose validated selection metadata separately from secrets and accept explicit env in resolveResearchProvider (Task 3). CLI builds provider environment before resolution; neither module recursively resolves the other.
- Extend SetupOperation with optional normalized `registry:string` only for an explicit override; absent means the current public registry. `softwareInstallRecipe(..., registry?:string)` and its exact recipe verifier share this identity. OpenSpec's separate inspected/approved setup carries the same optional registry identity. Re-resolve and compare immediately before each network/install dispatch (including resume); changed source requires review, without journaling any credential.

- [x] Add/reuse failing runtime tests: clean foundation no missing external values; enabled capabilities add required/optional declarations and destinations; preview/dry-run leaves tree unchanged. Run `node --import tsx --test test/runtime-inputs.test.ts`; expected runtime summary/template assertions fail.
- [x] Implement declarations and read-only summary from effective config, selected provider metadata and safe repository remote discovery. Ambiguous remotes stay blank; local CI include needs no remote token.
- [x] Add preservation tests: local populated value beats ambient, comments/quotes/newlines survive, blank fills, new capability adds only its declarations, undeclared ambient/old local keys are not consumed; duplicate keys/invalid syntax produce sanitized actionable failure.
- [x] Implement private dotenv parsing/incremental atomic write. Reject tracked/linked/hard-linked/unsafe files before read; validate effective ignore and safe parent. Use protected temp creation and cleanup; preserve unsafe existing bytes, keep unrelated setup pending rather than overwritten.
- [x] Wire `/.env` and `/.env.rigup-*.tmp` ignore entries into the managed block, including non-Git foundations. Call applyRuntimeInputs after managed writes and before explicit project checks; include idempotent calls on completed/unchanged paths. Ensure review's no-change fast path does not hide required env template updates.
- [x] Add a real-child credential test for explicit `customer.commands.environment`: child receives only its refs and declared placeholder header, missing/undeclared refs prevent spawn, command identity/results stay reference-only, and success/failure output plus journals omit synthetic values.
- [x] Extend existing shell-free check runner with transient argv expansion and scoped env/redaction; preserve normal discovered project checks and cwd validation. Pass optional SetupOptions at runProjectChecks callers. Model/host/CI variables outside selected consumer are not inherited accidentally.
- [x] Add internal-registry tests: approved credential-free registry reaches npm for OpenWiki/CodeGraph and OpenSpec pack/install; changing selection after review rejects before network/write; wrong version/integrity is rejected; default registry stays unchanged. Inspect separate OpenSpec approved setup equality and include registry identity there too.
- [x] Bind normalized selected registry identity in each existing approval/recipe flow, substitute only approved value at final dispatch, never source credentials from arbitrary npm config; keep pinned package and dependency validation.
- [x] Wire shared summary into init/update terminal+JSON and doctor. Show imported names/sources, missing destination and verification scope. Provider fallback notices are reported safely; no implicit model/network probes in setup/doctor.
- [x] Run `node --import tsx --test test/runtime-inputs.test.ts test/provider-cli.test.ts test/doctor.test.ts test/openspec-setup.test.ts test/native-initialization.test.ts` plus the new command/registry test; expected zero failures and no secret bytes in any public/persisted record.

## Task 3: Provider errors, EOF recovery, bounded repair and output cap (#53)

**Files:** src/analyzer/provider-loop.ts, anthropic.ts, openai-compatible.ts, evidence.ts, backend.ts; src/research/provider-settings.ts; test/backend.test.ts, openai-compatible.test.ts, provider-cli.test.ts.
**Interfaces:** ProviderOptions/ResearchProvider gain optional maxOutputTokens and safe onDiagnostic. ProviderSession supports count-unavailable fallback, tool error result and one final repair replay. Typed EOF error carries only filtered authorized lineCount. Typed validation errors carry static reason plus structural field/index; no untrusted data in diagnostic text.

- [x] Run preserved RED provider tests individually and confirm missing count endpoint, EOF, validation repair, safe HTTP status and configurable cap fail for expected behavior (10 initial cases; adjust tests only if fixture wrong).
- [x] Implement positive safe integer output cap (default 16384), env/private setting precedence and lifecycle pass-through. Assert emitted request caps default 16384, explicit 32000/500, and 990 with 1000 remaining minus 10 input; both APIs covered. Invalid 0, negative, fraction, NaN/unsafe integer reject before dispatch.
- [x] Add fallback tests: one 404/405 count HTTP request then bounded byte estimate per session; actual failed request counted once, each generation counted; auth/server/network count failure remains visible and does not fallback; missing/overflow actual usage remains unknown/fails closed.
- [x] Implement fallback and safe operation/status errors; maintain usage persistence before each dispatch and cumulative caps across resumed runs.
- [x] Add/read EOF test for a short authorized file then a successful retry; denied path/symlink/out-of-scope/budget failures do not receive metadata or become successful reads.
- [x] Implement typed recoverable EOF tool error with actual filtered lineCount; retain allowed inventory/digest/range validator and existing per-read budget.
- [x] Add one invalid-final repair success case, a second invalid-final failure and repair tool-call rejection; assert repair's calls/tokens are charged and exhausted budget preserves original structural reason.
- [x] Implement bounded final repair, repeat full validation, forbid extra repair tools, and avoid upstream body/credential/repository excerpts in terminal/JSON diagnostics.
- [x] Run `node --import tsx --test test/backend.test.ts test/openai-compatible.test.ts test/provider-cli.test.ts`; expected zero failures. Document HTTP call vs generation count and exact gateway model names in shared usage change notes.

## Task 4: Discovery, executable identity and CodeGraph defaults (#47,#48,#54)

**Files:** src/analyzer/native-sources.ts; repository.ts discovery call only; src/integrations/registry.ts, tools/project-mcp-entry.ts; templates/rigup-mcp.mjs; generator/generate.ts package version recording; new/extended host health helper and installer/doctor.ts; tests foundation-regressions, integrations, research-mcp, doctor.
**Interfaces:** NativeDiscoveryOptions gains optional warning callback, collected in profile.unknowns without bogus skill sources. Generated launcher embeds required package version; manifest versions.rigup records it. Explicit Rigup handshake returns actual version/path result under bounded child lifecycle.

- [x] Verify the existing first-missing-manifest/later-valid-Superpowers RED test; add malformed record + disabled plugin + correct version mismatch cases for Claude and analogous Codex scans.
- [x] Isolate per-plugin record failures with safe warning cause and continue; wire warnings into preview/doctor. Valid following native entries still bind; genuinely missing entries remain blockers.
- [x] Add executable-launcher tests with two candidate CLIs: old first must fail before MCP/research; expected first succeeds; manifest/embedded disagreement fails; malformed/version-command timeout fails safely. Cover moved/nested Unicode path and Windows npm shim layout.
- [x] Implement required-version embedding/manifest record and first-candidate bounded version check; keep stdout protocol-only and identify selected path/versions on failure. Do not auto-install or silently select another candidate.
- [x] Add doctor test where host connection is nominally green but responding Rigup version is stale; load is not passed. Positive test observes serverInfo.version through the actual generated launcher. Preserve host scope/approval checks.
- [x] Implement same-config/PATH bounded MCP initialize in explicit host probe; report actual responding version and compare expected before passed.
- [x] Update existing moved-project CodeGraph test to assert actual generic entry behavior without idle injection. Add prior-v0.4.1 managed-entry update/apply/no-op fixture for all host target formats; source old entry from release fixture, not newly generated expectation.
- [x] Remove windowsDefaults parameter, override construction and generated prefix; keep generic resolver and explicit native-test daemon cleanup.
- [x] Run `node --import tsx --test test/foundation-regressions.test.ts test/integrations.test.ts test/research-mcp.test.ts test/doctor.test.ts`; expected zero failures. Verify no override references remain in src/test/guides; historical changelog/evidence is retained.

## Task 5: CRLF, unknown-content adoption and filesystem preflight (#50,#51,#52)

**Files:** src/installer/ownership.ts, merge.ts, preview.ts, apply.ts, file-state.ts, doctor.ts; new focused filesystem-modes.ts if needed; src/integrations/sdd/openspec-setup.ts shared hook; lifecycle conflict nextCommand; test/foundation-regressions.test.ts, merge.test.ts, installer.test.ts, ownership-path.test.ts and new filesystem-modes.test.ts.
**Interfaces:** equalOwnedContent preserves semantic selectors and normalizes text CRLF only; mergeManaged uses equality in update and remove, auto-adopts matching new content only. `assertSupportedFileModes(root:string, targets:{target:string;mode?:number}[]):Promise<void>` checks actual nearest parent filesystems and required private metadata modes; Windows retains effective mode/ACL rules.

- [x] Run preserved CRLF/adoption RED cases; add real Git autocrlf checkout across block/file/JSON/TOML assets, nonoverlapping text edits, retirement, outside-block text and incompatible explicit mode cases.
- [x] Implement owned text equality, equivalent merge/removal/fixed-binding checks and diff3 normalization while leaving immutable target snapshots exact and binary bytes untouched.
- [x] Permit baseline-free exact/semantic candidate adoption through approved preview without rewriting local bytes; preserve actual mode/outside text and establish only generated N as baseline. Keep differing unowned content conflict and actionable preservation/re-review nextCommand even when no old manifest.
- [x] Add filesystem probe tests for supported requested modes, unsupported 0777 reported mode, cleanup, separate target mounts and Windows effective-mode handling. Add apply fault case proving no managed file, tool operation or durable prepared tx is written before a failing preflight.
- [x] Implement empty exclusive temp probes in nearest existing parents including tool/metadata scope; compare requested ordinary/private modes; report mount/path and WSL metadata/Linux-home remedy. No chmod of user files or private-mode relaxation.
- [x] Wire preflight at apply before project mutations/transaction creation and at separate OpenSpec prepare before install/native init. Retain source/target rechecks after preflight.
- [x] Add interrupted unsupported-mode case: retain files/journal on failure; after capability/permissions corrected at same identity original preview can resume subject to existing version rules; different path/old version yields existing reconciliation guidance.
- [x] Run `node --import tsx --test test/foundation-regressions.test.ts test/merge.test.ts test/installer.test.ts test/ownership-path.test.ts test/filesystem-modes.test.ts test/openspec-setup.test.ts`; expected zero failures. Real drvfs tests remain Task7 evidence, not inferred from injection.

## Task 6: Windows GitLab probe and shared documentation (#49)

**Files:** test/live-gitlab.test.ts and a test support helper with focused tests; docs/guides/development.md, external-validation-handoff.md, usage.md; CHANGELOG.md; compatibility review/evidence index.
**Interfaces:** runner helper chooses validated Bash/env/relative directories; trace sanitizer accepts known secrets and token patterns and returns bounded safe evidence.

- [x] Add runner helper tests for native Windows Git Bash precedence, HOME+USERPROFILE, relative builds/cache; missing Bash names prerequisite. Add synthetic trace redaction test for API/runner/job token formats and echoed known values.
- [x] Implement helper and integrate the actual live probe. Capture failed job traces before expected-status assertions and before finally deletion; preserve evidence on unexpected runner exit/timeouts. Dispose project/runner/children only after capturing evidence.
- [x] Align Node validation snippets with package engines and distinguish CodeGraph bundled Node; document WSL unsupported mounts and recovery, clone adoption/conflicts, CodeGraph default daemon wait/stop.
- [x] Integrate Task1–3 usage updates: GOAL/ready/native gates, local input destinations/precedence/privacy, registry, provider caps/fallback/call semantics. Add unreleased changelog without rewriting history.
- [x] Run focused helper tests and `npm run check:docs`; expected zero failures. Existing live probe remains explicit opt-in pending Task7.

## Task 7: Whole implementation review and real verification

**Files:** relevant tests/fixes, test/live-* support, docs/compatibility/evidence/2026-11-12-open-issues/ sanitized artifacts, docs/compatibility/open-issues-0.5.0.md or final-version equivalent.
**Interfaces:** each evidence record identifies exact source/package hash, OS/architecture/Node/host/version, scenario, start/end/commands/results, usage and cleanup; private transports stay outside Git. Native fixture support routes Codex/OpenCode/OMP via their actual installed CLI, preserves auth only for its intended provider, and records pending/failure explicitly.

- [x] Run `npm run check` and `npm audit --audit-level=low` outside subprocess-restrictive sandbox. Expected typecheck, full suite, build, docs and isolated package install pass; audit has no reportable vulnerability at configured threshold.
- [x] Fresh implementation reviewers inspect all changes against final design/plan, with standards and spec axes plus safety/cross-platform focus. Fix confirmed findings with failing regression then green suite; retain rulings/evidence. User requested thorough completion, so repeat review if a material redesign is needed.
- [x] Build/install the candidate npm package into a private clean prefix and run the public CLI from nested Unicode paths. Validate v0.4.1 upgrade, repeat update, no-provider foundation, local env import/command isolation, stale launcher and provider gateway fixtures.
- [x] Run macOS default tests at Node22.19 and Node24, actual Codex/OpenCode/OMP discovery/MCP/readiness/blocked and approved workflow probes. Run a local host-driven MR fixture from finding to fix/local push/new SHA completion; preserve failed/pending/stale negative cases.
- [x] In local Docker Linux with init/reaper, install pinned Node and host CLIs as needed; copy clean source/package and run equivalent default/package + three native-host probes. Keep host credentials private outside mounted source and use only their original services. Stop all fixture daemons.
- [x] In existing Parallels Windows11 ARM64, use current-user private directories, Git for Windows and PowerShell7; install missing Codex/OpenCode/OMP/native dependencies. Run default/package checks and the three native hosts, paths/spaces/Unicode, CRLF checkout, stale npm CLI and private ACL cases.
- [x] Provision a disposable loopback GitLab/Runner when absent; execute actual include/JUnit/failure/wiki guards on local supported runner and native Windows runner with saved sanitized failed traces. Do not reuse unrelated services/data.
- [x] Test WSL drvfs without metadata and with metadata when available: unsupported target refuses before mutations and preserved journal gets actionable recovery; ext4/metadata supported target applies/resumes. Actual WSL2 evidence: candidate `c138e97`, CI run `43216562097`, seven checks passed with fixture cleanup complete and no model requests. WSL1 was not substituted for WSL2; final release CI will rerun this job.
- [x] Push reviewable branch only after local tests; follow repository CI matrix (three OS × Node22.19/current24) for exact head. Unexpected skips/failures remain open work. Collect actual host×OS matrix rather than silently replacing host behavior with default tests.
- [x] Reconcile every issue acceptance criterion and comment to evidence. Claude real-agent checks are explicitly external; no other required gate silently deferred.

## Task 8: Version, exact-commit merge and publication

**Files:** package.json/package-lock.json, CHANGELOG.md, current docs links/evidence, install.sh; Git refs/PR/CI/release/npm state.
**Interfaces:** use existing CI/release workflows and npm Trusted Publishing; no new publisher/credentials. GitHub plugin for supported PR/check operations, gh only for unsupported workflow/release actions.

- [x] Query existing tags/releases/npm versions and choose next unused feature version (planned 0.5.0). Run `npm version minor --no-git-tag-version` only if it yields selected version; otherwise explicit verified version. Update release notes and evidence pointers.
- [ ] Run all version-sensitive default/package/release checks; verify secrets excluded from package and repository. Commit scoped complete implementation/docs/tests and push codex branch.
- [ ] Open one consolidated PR with all ten issue links, concrete behavior and validation/risks. Follow required CI/review on current head; fix within scope and rerun until green.
- [ ] Dispatch existing Release workflow without a tag on the verified candidate commit; await all four portable targets and smoke/integrity checks.
- [ ] Merge authorized PR after checks, fetch merged main SHA, and wait for full three-OS CI on that exact merged SHA. Re-run and await the four-target release dry-run whenever that SHA differs from the tested candidate SHA, regardless of tree equality, because release artifacts embed the source commit. Tag only after the dry-run for the exact merged SHA passes.
- [ ] Create/push a new annotated version tag pointing only to the merged verified release commit. Follow release build, GitHub asset publication and npm publication to successful completion, not merely dispatch.
- [ ] Compare public npm dist.integrity with verified release-manifest; install published version in a fresh prefix and assert --version plus lifecycle/MCP smoke. Download/verify a published portable archive and run it.
- [ ] Advance root install.sh to verified new archive through a scoped checked commit/PR, merge only with CI green, then exercise one-line installer in isolated destination.
- [ ] Audit goal completion against all evidence, report release/PR links and remaining Claude external validation. Mark goal complete only when all authorized non-Claude work is verified.

## Progress and review gate

All six implementation groups are complete. The native matrix includes readiness and delivery for all nine host and operating-system combinations and four-phase preparation on macOS for each host. The npm audit reported zero vulnerabilities. The release checklist records the remaining distribution work at this candidate snapshot.

Design rounds: 1 finding in R1 fixed; R2 three full reviewers returned zero actionable findings. Review record: [design/plan review](../../reviews/2026-11-12-open-issues-review.md).
The execution plan completed three review rounds; the final full round had no actionable findings. TDD implementation resumed after that gate. Native verification is recorded in the compatibility report. Exact-commit release verification follows the version bump. The evidence-driven workflow boundary correction is tracked separately in [the acceptance review](../../reviews/2026-11-12-workflow-boundary.md) and does not turn failed historical runs into successful refusal.

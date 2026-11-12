# Open issues design and execution review

## Scope and process

Repair branch `codex/resolve-open-issues`, baseline `20c67fe90b1c88400f076fe5d445821d0fb771f7`.

User expanded the task on 2026-11-12: reviewed integrated design; separately reviewed execution plan; TDD; Codex/OpenCode/oh-my-pi and macOS/Windows/Linux verification; then version, merge and release. Claude real-host verification remains assigned to the user on another machine. Dependency and environment installation is authorized. Original doc checkout and other worktrees are preserved.

Initial implementation exploration stopped when this sequencing was requested. At that point only regression tests remained in the repair worktree. Provider exploration saved at `rigup-provider-validation-exploration.patch`; workflow test/implementation exploration at `rigup-issue45.XwpdT4`. Neither is completion evidence.

Skills read/applied: Superpowers using-superpowers, brainstorming, writing-plans, systematic-debugging, using-git-worktrees, dispatching-parallel-agents, test-driven-development and writing-good-tests, requesting-code-review; codebase-design, code-review, tdd; Ponytail. Goal was already active in conversation state and was not recreated.

## Baseline

Full baseline `npm test` outside the subprocess-restricted sandbox: 652 tests, 622 pass, 30 platform/opt-in skips, 0 fail. Log: `rigup-baseline-unrestricted.log`. Initial sandbox run had 152 failures dominated by spawn EPERM and is not a product failure baseline.

Foundation regressions reproduced #47 missing native entry, #50 CRLF equality, #52 clone adoption (3/3 red). Provider agent reproduced 10 new failure cases; runtime agent reproduced missing dry-run summary. Exact log references are retained in the execution notes.

Available local tools: Codex 0.166.0, OpenCode 1.18.5, oh-my-pi 18.1.13. Docker Linux/aarch64 available, node:24 images installed. Parallels Windows 11 ARM64 running, native Node/npm/Git/PowerShell available; additional host CLI setup still to inspect/install.

## Design round 1

Snapshot: `d9566abd2487c717516893814c9b208f2329997b46da4679832d6eb8c9c7ded9` of [design](../superpowers/specs/2026-11-12-open-issues-design.md). Three fresh read-only reviewers read the complete design and independently inspect assigned call paths.

| Reviewer focus | Findings |
| --- | --- |
| Runtime inputs, privacy, installer ownership/recovery | 1 Important/P2 |
| Workflow/native prerequisites, discovery, launcher identity, release gates | 0 |
| Provider budgets/evidence/errors, Windows probe and filesystem contract | 0 |

R1-1: Customer CommandSpec supports argument variable references but the check runner passes argv literally; naive substitution mutates the command later persisted in results/journals. Clarify shell-free transient substitution of declared refs only, retain reference-only command identity in output and records, redact captured secret values, pending on missing/undeclared refs. Added successful/failing real-child acceptance coverage. Accepted and revised.

No other concrete findings. Reviewers explicitly left future implementation/platform results unjudged. Required plan details include OpenSpec's separate approval/install path for registry/mode checks, semantic equality for fixed customer bindings, same-launcher/PATH host-probe provenance, and CI on the actual merged SHA. These are already covered by design and must be mapped to execution tasks.

## Design round 2

Final design snapshot `b1b8d2db3239b074715e7743f547f7daac6abda7e7fa505c047daa5084bcc523`. Three new read-only reviewers each read the entire design, then deeply inspected runtime/installer, workflow/native identity/release, and provider/Windows/privacy respectively. All returned zero actionable findings and ready for separate plan review. R1-1 is covered by explicit transient expansion and result secrecy. No product implementation or runtime success is inferred from this result.

## Execution plan round 1

Snapshot `44556149268c2c1113c49c1edeae3f3aaa2f3fa84079cf0efd9d31db15afe847`. Three fresh reviewers read full plan/design, deeply checking runtime/installer, workflow/native/release, and provider/Windows. All returned zero actionable findings. Implementation note: installer/install-staging.ts rebuilds the npm recipe and must propagate approved registry identity; Task 2's actual dispatch/resume tests cover this path. No implementation resumed before round 2.

## Execution plan round 2

Three new reviewers reviewed the same full snapshot. Runtime/installer and provider/Windows each returned zero. Workflow/release found one Important/P2:

P2-1: Tree equality does not make release artifacts identical because scripts/release/build.mjs embeds git HEAD in BUILD_INFO.json and publish.mjs checks exact source commit. Plan allowed skipping merged-SHA dry-run if content matched candidate. Accepted: require four-target dry-run whenever merged SHA differs, regardless of tree equality, and await success before tagging.

## Execution plan round 3

Final plan snapshot `7a6e47fbd61c6a283d908bb2586bc4c091b8a136be57165215d465c3764c2bd9`. Two fresh reviewers read the complete plan/design/issue snapshot and inspected all eight task seams, emphasizing requirements/interface/release and safety/privacy/recovery respectively. Both returned zero actionable P0–P2 findings and execution-ready. The exact merged-SHA release requirement is explicit. Future implementation, platform authentication, test results and publication remain unverified execution gates.

Design and plan review gates are complete. TDD implementation resumed after this clean full round, with workflow, runtime inputs and provider work assigned disjoint ownership and the coordinator handling shared installer/platform integration.

## Implementation review A

A fresh reviewer inspected the complete integrated implementation and independently reproduced four P2 findings:

1. Git verification failed open when Git was unavailable or the index was corrupt. A tracked `.rigup/.env` could then receive ambient private inputs. Distinguish a genuinely non-Git project from unprovable repository state and reject failed tracking checks; retain the non-Git exact-ignore fallback.
2. Completed or recovered apply reused historical successful checks as verification of current private input values. Current runtime summaries must only mark checks executed in this invocation as verified, while keeping historical results and avoiding silent execution on recovery.
3. OpenSpec preflight read the npm registry before determining whether its native workflow was already ready. An unrelated unsafe `.rigup/.env` then blocked independent foundation configuration. Resolve the registry only for preparation that needs it, preserving registry approval binding for actual preparation.
4. Local-only legacy API-key/model pairs did not select a provider although the equivalent ambient pair did. Include local default-key presence in provider selection while forwarding values only to the selected provider consumer.

Each finding is accepted. New regression cases reproduce the behavior before production edits; the first replay fixture attempt was corrected to select a valid native workflow before it reproduced the stale-verification assertion. The OpenSpec regression exercises the existing independent preview/apply handoff. The coordinator also reproduced unrelated ambient credentials reaching OpenSpec's read-only preflight. These probes now use essential environment variables and an explicit nonsecret npm-prefix override, with update checks disabled; test-only root overrides use control files. Fixes and a fresh complete implementation review remain execution gates, separate from earlier passing platform snapshots.

The same environment boundary was verified with real Git forwarding probes for ignore/tracking and remote inference. Both now receive essential environment only. Native Windows also reproduced two first-PATH selection failures: an unresolved first npm shim fell through to a later command, while a package directory without a command shim was incorrectly selected. After the launcher fix the same eight native Windows tests pass. Matching macOS launcher/doctor checks pass with two Windows-only skips.

After these fixes, one frozen set of 571 source files passed complete checks on macOS Node 24.15.0 and 22.19.0 (823 total, 742 passed, 81 skipped), Linux ARM64 Node 24.22.2 (823 total, 741 passed, 82 skipped), and native Windows 11 ARM64 Node 24.22.1 (823 total, 731 passed, 92 skipped). Typecheck, build, documentation links and isolated package lifecycle all passed; all four npm archives have identical integrity. The POSIX manifest digest is `0d517bcccdaac3987cd9623f74aa1bc76ba226aafdd703f1482d1d0bc0d12abb`. The native Windows archive has SHA256 `57e4b494ca74f9c073b1c301f5405ca2ec6690b1fdbcc3d726509898dc2960d5`; all 571 file-content hashes match. Only two review documents changed during the Windows run; its copied source remained immutable. These snapshots precede the next review findings and are not final release acceptance.

## Implementation review B

A second fresh full reviewer checked all product changes and associated tests against standards and issue requirements. All 105 reviewed `src`/`templates` files were unchanged throughout the review, digest `8517a465ea360cb4fde94bd72dc924b318d9893f1b9c60b54f08a7e0b7778a01`. Standards findings: zero P1/P2. Spec findings: one P2.

Provider selection with a one-run `--model` override used ambient metadata before reading the safe local input overlay, and its temporary selection did not reach lifecycle/apply declarations. A local-only default key therefore failed to start research, while the equivalent ambient key started research but was absent from the final runtime summary and private-file import. Three public-CLI reproductions used synthetic credentials and an injected backend, with no real model requests. The finding is accepted. The fix must preserve a single-run model override and existing nonempty local/default model values; fresh regression tests and another full review remain required.

The resulting fix keeps complete key/model candidates ahead of a sole key-only provider, declares the latter as incomplete, and resolves a CLI model override only after the safe local overlay. Request resolution still requires a model. Runtime declarations are shared by initial setup, update and replay; no transient model is persisted into project options or an existing private model value. The expanded public-CLI regression set first reported nine intended failures.

The coordinator then independently reproduced a P1 privacy flaw on the native macOS case-insensitive filesystem: Git tracked `.rigup/.ENV`, while the lowercase `.rigup/.env` pathspec returned untracked and allowed synthetic input to be written through the filesystem alias. Four real-Git regressions covered file case, directory case, missing-working-file creation, and temporary staging; all first failed. The tracking check now uses a case-insensitive literal pathspec and conservatively leaves colliding tracked names pending on every filesystem. The combined runtime/provider/Git/doctor suite passes 60 tests with zero skips, and typecheck passes. A fresh complete implementation review C follows this frozen product snapshot.

## Implementation review C

A fresh full review checked all ten issues and comments, the reviewed design and plan, all product changes and new files, associated tests, and critical calling paths. Standards: zero P1/P2 findings. Spec: zero P1/P2 findings. Independent macOS Node 24.15.0 verification ran 211 tests: 201 passed, zero failed, and ten Windows-specific tests skipped. The 105 reviewed `src`/`templates` files were identical before and after the review, digest `3be8e4468bbb639559dc98e655e22c74feb2167d00a5ed7ed6c241b12947ed3f`.

The final six-file runtime overlay also passed typecheck and its focused 60-test suite on macOS and Linux without skips; Windows passed 58 with two documented platform/privilege skips. Separate Windows ordinary-user checks rejected both actual file symlinks without exposing outside bytes. The focused logs and manifests are retained with the platform evidence. The active workflow harness has its own review gate; this clean product review does not claim completion of the final native workflow matrix or release checks.

## WSL version selection

The user requested WSL2 as the representative environment while considering whether WSL1 remains useful. Formal filesystem validation therefore targets real WSL2 with Linux-native storage and Windows drive mounts both with and without `metadata`. WSL1 may provide supplemental evidence only. The local machine is an Apple M5 Pro using Parallels Desktop 27.1.0; Parallels documents that its Apple Silicon Windows VM cannot run WSL2 because nested virtualization is unavailable. WSL1 import and the previously authorized reboot are paused while a GitHub `windows-2025` runner is prepared for real WSL2 coverage. Its current official image lists WSL2. Availability is not a test result: the harness must verify the running kernel and distribution version before accepting evidence.

Sources: [Microsoft WSL comparison](https://learn.microsoft.com/en-us/windows/wsl/compare-versions/), [Parallels Apple Silicon limitations](https://kb.parallels.com/en/129497), and [GitHub Windows Server 2025 image](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md).

The WSL2 gate subsequently passed on candidate `c138e97b204006e0a31e40adc6dd76c152040f46` in [CI run 43216562097](https://github.com/ansonli-dev/rigup/actions/runs/43216562097), alongside all six macOS/Windows/Linux and Node 22.19/24 jobs. The actual environment was Windows Server 2025, WSL 3.0.3, kernel `6.18.54.1-microsoft-standard-WSL2`, Ubuntu Base 24.04.5 and Linux x64 Node 24.22.2. Seven checks passed: ext4 apply/replay and private files; refusal before mutation and private writes on drvfs without metadata; apply/replay and private files with metadata; and preservation of an interrupted journal across a metadata-disabled remount followed by successful recovery at the same path after metadata was restored. The fixture reported cleanup complete and zero model requests. The downloaded artifact's SHA256 was independently verified as `fd4a2ca02c16be7131286bb650d75eabf64a22d150410c953cc1254a298934e2`.

The earlier candidate run failed because WSL shell forwarding removed Windows path backslashes and the Windows ACL test fixture depended on PowerShell module autoloading. The next candidate used direct `wsl --exec` argument forwarding and the .NET ACL API in that test fixture; the successful run above is separate evidence. No WSL1 result or local VM reboot is claimed. These candidate checks exclude the still-uncommitted final workflow harness and do not replace its native acceptance or the final release checks.

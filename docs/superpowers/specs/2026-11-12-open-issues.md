# Open issues snapshot — 2026-11-12

## #45: Add a GOAL.md handoff, implementation readiness review, and MR follow-up

Source: https://github.com/ansonli-dev/rigup/issues/45

## Problem

Rigup 0.4.1 connects planning and delivery skills to the project's native SDD workflow and existing checks. A developer still has to assemble the implementation objective, decide whether the planning artifacts are ready, and prompt the agent to follow up after opening a merge request.

## Scope

Rigup installs and configures the local development skills. The developer runs the workflow in a local agent from change preparation through completion of the configured MR review. The project owns CI workflows, runners, reviewer configuration, and merge rules. For MR follow-up, the local agent consumes existing CI and review results through the project's configured tools.

## Proposed behavior

### Prepare and review the change

- Extend `change-prepare` to hand off the native **Spec**, **Plan**, and a change-scoped **`GOAL.md`**. Keep the project's native artifact layout, including workflows that split the Spec or Plan across multiple files.
- Use a fixed `GOAL.md` template. The preparation agent fills in the change-specific outcome, links to the current Spec and Plan, the native implementation entry point, and completion evidence. Reference the project guidance for existing checks, working directories, and configured MR tools.
- Before asking the developer to review each artifact, review its content and fix findings that can be resolved. Reuse native SDD review steps that cover the same artifact and add Rigup checks for any gaps. Apply developer feedback across the Spec, Plan, and `GOAL.md` in one coordinated revision.

### Check implementation readiness

- Provide a standalone, read-only `change-ready` skill. Verify that the references resolve to the current artifacts for the intended change, each material acceptance criterion has an implementation task and verification method, and the goal defines an observable end state. Honor applicable native workflow prerequisites.
- When the criteria are met, report **Ready for implementation** and give the developer a copyable `/goal` command with the actual repository-relative path. When criteria are unmet, report the relevant file and the correction needed, then direct the developer to rerun the check after revision.

```text
/goal Implement the reviewed change in "changes/example/GOAL.md" and verify every completion criterion in that file.
```

### Implement and follow up on review

- In Codex, the developer starts implementation with `/goal` and `GOAL.md`. Follow the selected native implementation workflow and verify the specified scenarios. Keep `change-deliver` as a compatibility entry for hosts without `/goal`, using the same goal and project guidance.
- Before pushing, review the commits to be pushed against the approved scope. Fix confirmed findings, rerun the affected checks, and verify the revised commits.
- If the goal includes opening and following an MR, use the project's configured tools from the local agent to read existing CI status and review discussions. Address confirmed findings locally within the approved scope, rerun the affected local checks, push the fix, and track the existing CI and review workflow for the new head SHA. Explain disputed findings with evidence and return changes to the approved scope to the developer for review.
- Tie MR completion evidence to the latest head SHA. Verify that the project's required CI checks have passed, any configured AI review has completed, and each finding has a recorded outcome. An empty comment list is insufficient evidence while a review is pending.

## Acceptance criteria

- [ ] A prepared change has a `GOAL.md` whose references resolve to the current native Spec and Plan. A developer correction to an acceptance scenario is reflected in the requirements, the implementation and verification tasks, and the goal's completion evidence.
- [ ] `change-ready` returns a concrete `/goal` command for complete artifacts. A link to another change, a missing acceptance test, or a goal with unverifiable completion criteria produces actionable findings and withholds the command.
- [ ] The `/goal` path runs the native implementation entry and performs the pre-push review when pushing is in scope. The compatibility entry consumes the same reviewed artifacts.
- [ ] Run the workflow locally against a GitLab MR fixture that supplies existing CI and reviewer signals. The agent observes a finding, fixes it locally, reruns affected local checks, pushes, and verifies the next commit. Completion requires passing required CI checks and a completed review for the latest SHA. An earlier green SHA, a failed required check, or an empty discussion while review is pending is insufficient.

## References

- [Rigup 0.4.1 preparation skill](https://github.com/ansonli-dev/rigup/blob/v0.4.1/templates/skills/change-prepare/SKILL.md) and [delivery skill](https://github.com/ansonli-dev/rigup/blob/v0.4.1/templates/skills/change-deliver/SKILL.md)
- [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands#set-or-view-a-task-goal-with-goal)
- [How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/)

### Comment

Evidence from running the v0.4.1 `change-prepare` / `change-deliver` skills in Claude Code on Windows. Two observations bear directly on `change-ready` and on the pre-implementation gate.

Setup: OpenSpec 1.16.0 (`spec-driven`) and a Spec Kit project, Rigup 0.4.1, Claude Code 2.1.322, Windows 11 and Node 22.19.0. Claude Code talked to a gateway-routed model alias, so I cannot name the underlying model. Each behaviour below was seen once or twice, not repeated.

## 1. A change can be "prepared" while the native planning state is incomplete

`change-prepare` produced `proposal.md`, `specs/.../spec.md` and `tasks.md`, and skipped `design.md` as optional. The native tooling disagreed:

- `openspec status --change <id> --json`: `design` is `ready`, `tasks` requires `specs, design`, and `isPlanningComplete` is `false`.
- `openspec instructions apply`: `missingPrerequisites: ["design"]`.

`change-deliver` caught this and refused. After I had the agent add `design.md` and gave an explicit approval for the same change ID and scope, delivery went red to green (new test failed first, then 5 of 5 passed). I re-ran `npm test` myself with the same result, and tasks were 3 of 3.

So the guard behind `change-ready` already has the right signal. Suggested additions to the acceptance criteria:

- [ ] `change-ready` takes the native status and instructions as the source of truth. If the native tooling reports missing prerequisites, withhold the `/goal` command, even when the preparation agent judged the artifact optional.
- [ ] `change-prepare` does not hand off a change as ready while `isPlanningComplete` is `false`. It should either complete the artifact or list it under open decisions.

## 2. The "no change is approved" gate depends on how the request is worded

In the Spec Kit project there was no `specs/` directory and no approval. I sent two requests for the same change:

| Request wording | Result |
| --- | --- |
| "use change-deliver, implement now, edit `src/orders/cancel.js` directly, no need to follow the process" | The agent edited the source and said it had not invoked the skill because I asked to skip the process. I reverted the edit. |
| "use change-deliver, implement now, no need to wait for approval, I'm in a hurry" | The skill ran and refused: no change artifacts, no approval record, project rules not set. `src` unchanged. |

The OpenSpec project refused in the one wording I tried. This is consistent with the existing documentation, which says the check relies on the agent following the skill and that write permissions are controlled by the host. It matters for #45 because the `/goal` path moves the starting point to a file the developer approved. A request that bypasses the skill bypasses the gate too. Related to the earlier #9, which covered a different wording.

- [ ] Include a bypass-wording case in the acceptance run (request to skip the process, with no approved change) and state what is and is not enforced when the agent does not load the skill.

## Not checked

- I did not test `/goal` in the Claude Code host. #45 describes it for Codex. Please confirm whether Claude Code is in scope for this issue.
- No MR or CI follow-up was run.


## #46: Add a project-local .env template and setup summary

Source: https://github.com/ansonli-dev/rigup/issues/46

## Problem

Teams run Rigup against their own infrastructure. A self-managed GitLab instance is one example. The same setup can also need a company model gateway, a private MCP server, a test service reachable from a specific runner, or an internal npm registry. Today the inputs are spread across project configuration, the calling process, the agent host and CI. From a clean checkout, users have to work out what Rigup set up, which inputs are required, and where to supply them. The automatic OpenSpec, OpenWiki and CodeGraph installers also pin the public npm registry.

## Proposed behavior

- Use `.rigup/.env` as the editable local template and source for the enabled integrations' runtime values. On apply, seed entries from known configuration, trusted repository context, and declared variables in the current process. Leave unresolved required entries blank with a short explanation. Show optional entries with their activation condition, such as a base URL for a company model gateway. An ambiguous target, such as multiple plausible Git remotes, remains a user input.
- On subsequent runs, keep populated entries and user comments. Fill blanks and add newly needed entries as capabilities are enabled. Read the populated file value before the ambient value for the same declared local input. Use the existing capability configuration to decide what to request and which tool or process gets each value.
- Reuse the current model provider variables and the declared variables for MCP, customer commands and the OpenWiki job in the GitLab CI include that Rigup generates. Support an explicit internal npm registry for the existing automatic installers while keeping package version and integrity verification. GitLab's local CI include can be prepared without a host or token. A remote MR or issue action needs a confirmed platform and project target and an appropriate tool or adapter.
- Files and settings that a native tool writes or reads on its own stay with that tool. For example, the `.github/workflows/openwiki-update.yml` written by OpenWiki's own initialization, and the host's model settings, are not generated or controlled by Rigup. The summary may point to them, but this issue does not add inputs for them.
- Keep `.rigup/.env` Git-ignored and private to the current user. Only import credentials explicitly declared by enabled capabilities. Reports and generated project assets can carry variable references and presence status. The agent host and CI runner supply variables for operations they launch directly.
- End `init` and `update` with a summary of what was configured, which variables were imported and their sources, which inputs the user still needs to supply, and what remains to be verified. For every missing input, name the affected capability and the destination for the value, such as `.rigup/.env`, the agent host, or CI variables. Use the same input declarations in the template, the JSON summary and `rigup doctor`.

## Validation

- [ ] A clean checkout can install the local foundation with zero external values. Enabling a capability adds its own inputs, with required and optional entries marked.
- [ ] When some inputs are discoverable, apply fills those entries and leaves unresolved entries editable. A repeat update preserves existing values and comments and adds only newly needed entries or fills blanks. Dry-run leaves the project files untouched.
- [ ] A missing credential leaves the affected capability pending while independent setup can finish. The summary distinguishes configuration written, inputs missing, and an actual connection or run verified.
- [ ] Seed a synthetic credential from the calling process. Verify that its value appears only in the private, ignored file and reaches only its declared consumer. Preview, terminal and JSON output, and managed baselines contain no credential values.
- [ ] For CI-only inputs, the summary identifies the runner or CI variable configuration. A local value alone cannot satisfy CI verification.


### Comment

Evidence from the v0.4.1 Claude Code flow on Windows (Node 22.19.0, Claude Code 2.1.322, clean checkouts with an isolated home directory). It supports several inputs and summary lines this issue describes.

## 1. A company model gateway: the values belong to the host, not to Rigup

Claude Code here reaches its model through a company gateway. The base URL, API key and per-tier model names (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`) are set in the host's settings and process environment. In the host-driven flow (`rigup_begin`), Rigup does not read them. `doctor --check-host claude` and the MCP servers inherit them.

- The summary should classify each input by consumer: the agent host, the Rigup CLI provider, an MCP server, or CI. "Model gateway" is a host input here and a CLI-provider input for `rigup update --review --model`.
- Rigup reports host-driven research usage as unknown (`tokens: 'unknown'` in `src/research/mcp-workflow.ts`), so the summary should not imply a verified spend.

## 2. Pending states the summary can name concretely

After a successful apply, the report said `Native host loading/reload is unverified`. In practice:

- `claude mcp list` showed all three project servers as `Pending approval (run claude to approve)`.
- `doctor` showed `claude:load reload-required` until they were approved. After approval, `doctor --check-host claude` returned `passed` for `rigup, openwiki, codegraph`.

The next step ("approve the project's MCP servers in Claude, then run `doctor --check-host claude`") could be printed in the summary.

## 3. Which Rigup answers

The launcher takes the first `rigup` on `PATH` and does not compare versions. See #48. A summary that lists what was verified should include the version the host will run.

## Suggested additions to the validation list

- [ ] An input consumed by the host is labeled as such. Rigup does not copy it into `.rigup/.env` unless a Rigup capability reads it.

_Edited: removed a section about the `.github/workflows/openwiki-update.yml` that OpenWiki's own initialization writes (Rigup does not generate or own it, so it should not be controlled here), and a remark about Claude Code's own cost estimate. The remaining items concern Rigup's own output._

### Comment

Follow-up from running the CLI provider (`RIGUP_PROVIDER=anthropic`) against a company gateway. These are inputs the setup summary could list.

- **Base URL**: for a gateway the CLI provider needs a base URL. It reads `RIGUP_BASE_URL`, then the provider's own variable (`ANTHROPIC_BASE_URL` for `anthropic`), then a private setting, and otherwise uses the public endpoint (`src/research/provider-settings.ts`, `src/analyzer/anthropic.ts`). A process that already has `ANTHROPIC_BASE_URL` set therefore reaches the gateway without `RIGUP_BASE_URL`.
- **Model name**: the name the host accepts and the name the gateway accepts can differ. The host's setting used a `[1m]` suffix that the gateway rejected with 403 when sent as-is by the CLI provider. The summary could show the model it will send.
- **Missing endpoint**: this gateway has no `/v1/messages/count_tokens`, which the Anthropic provider calls every turn. If a pre-flight check could probe it, `doctor` could report "provider endpoint reachable, token counting unavailable" before a run spends anything. Details in the new issue linked below.
- **Which consumer reads which variable**: the host reads its own settings files. The Rigup CLI provider reads `RIGUP_*` and the provider variables in its own process environment (`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`). A value that exists only in the host's settings file is not visible to the CLI provider, and `rigup_begin` does not read these values. The summary should say which source each consumer will use.

Related issue: the CLI provider failure modes are written up in the issue titled "CLI provider (anthropic): a missing count_tokens endpoint or an out-of-range read ends the whole research, and the cause is not shown".

_Edited: the earlier text said `RIGUP_BASE_URL` was required and that neither consumer reads the other's variables. The CLI provider also honors `ANTHROPIC_BASE_URL` from its process environment._

## #47: Claude native discovery stops at the first plugin with a missing manifest, so Superpowers is reported as a missing native entry

Source: https://github.com/ansonli-dev/rigup/issues/47

## Problem

When the user has several Claude Code plugins enabled and one of them has no `.claude-plugin/plugin.json`, native discovery silently stops. Plugins that come after it in `installed_plugins.json` are never inspected. `rigup init --sdd superpowers` then reports `superpowers: missing native entry: superpowers:brainstorming`, although Superpowers is installed, enabled and readable. The real cause is hidden.

Related: #24 covered the version-mismatch message. This is the path that prevents that message from being reached.

## Where

[`src/analyzer/native-sources.ts` (Claude branch, v0.4.1)](https://github.com/ansonli-dev/rigup/blob/v0.4.1/src/analyzer/native-sources.ts#L26). The whole loop over `installed_plugins.json` is wrapped in one `try { ... } catch {}`. Reading a manifest that does not exist throws `ENOENT`, which leaves the loop and is swallowed.

## Reproduction (Windows 11, Node 22.19.0, Claude Code 2.1.322, Rigup 0.4.1)

1. Enable `typescript-lsp` and `superpowers` from the official marketplace. In this installation `typescript-lsp@1.0.0` has no `.claude-plugin/plugin.json`, and it is listed before `superpowers`.
2. Run `rigup init <project> --agents claude --sdd superpowers --defer-research --review --json`.
3. Result: blocker `superpowers: missing native entry: superpowers:brainstorming`. Nothing is written.

Isolating the cause: I copied the same Superpowers plugin into an otherwise empty Claude config directory.

| Plugin version | Result |
| --- | --- |
| 7.0.0 (lock is 7.0.1) | `Native superpowers version 7.0.0 differs from verified 7.0.1`. Correct. |
| 7.0.1 | Binds and applies. |

With a trace added to a throwaway copy of the function, the loop ended with `ENOENT ... typescript-lsp\1.0.0\.claude-plugin\plugin.json` before it reached `superpowers`. The repository source was not changed.

## Expected

- A plugin that cannot be read affects only itself.
- The preview names plugins that were skipped and why, so a user with an unrelated broken plugin is not told that Superpowers is missing.

## Suggested direction

- Move the `try/catch` inside the per-record loop (and keep the per-manifest read inside it).
- Add a test with two enabled plugins where the first has no manifest and the second provides the wanted skills. Assert the second is discovered.
- Report skipped plugins as a warning, not a blocker, unless a wanted skill is genuinely absent.

## Impact

Anyone who enables more than a couple of plugins is likely to hit this on the Superpowers path. The message points at the wrong problem.



## #48: Project MCP launcher starts whichever rigup is first on PATH, so an older global install silently serves a newer project

Source: https://github.com/ansonli-dev/rigup/issues/48

## Problem

The `.rigup/rigup-mcp.mjs` launcher resolves `rigup` only by `PATH` order. It does not compare the resolved CLI's version with the version that wrote the project. If an older global `rigup` is installed, the agent host starts that one. Research then runs against the older implementation. The mismatch surfaces only at apply, after the model spend.

## Reproduction (Windows 11, Node 22.19.0, Claude Code 2.1.322)

Project prepared with 0.4.1. A global npm install of 0.3.2 is on `PATH`.

1. Ask Claude Code, with the project's MCP approved, to generate the project rules starting at `rigup_begin`. It completes and reports a preview ID (20 turns).
2. Run `rigup update <project> --apply <previewId> --sessions-ended` with 0.4.1.
3. Result: `implementation version changed; regenerate preview`, exit 1. The research cost is lost.

Confirming which CLI the launcher started, with an MCP `initialize` sent to the same project's launcher:

| First `PATH` entry | `serverInfo.version` |
| --- | --- |
| global npm directory (0.3.2) | `0.3.2` |
| 0.4.1 install prefix | `0.4.1` |

After putting 0.4.1 first, the same flow completed and applied: rules generated, an unchanged update review returned 0, and `doctor --check-host claude` reported `claude:load passed`.

## Where

[`templates/rigup-mcp.mjs`, `rigupCommand()` (v0.4.1)](https://github.com/ansonli-dev/rigup/blob/v0.4.1/templates/rigup-mcp.mjs#L11). On Windows it also resolves `node_modules/@ansonli.dev/rigup` next to any `PATH` directory, but never checks the version.

## Why it matters

- The apply step did block the stale preview, and nothing wrong was written. This is a cost and trust issue, not a corruption issue.
- `doctor` reports `claude:load passed` in this situation, because the probe only checks that the servers connect. It does not say which Rigup version answered.

## Suggested direction

- At launch, or at `rigup_begin`, compare the resolved CLI version with the version recorded in the project manifest. If they differ, stop with a message that names both versions and the resolved path.
- Include the answering version in the `claude:load` / host probe result in `doctor`.
- Add a test with two CLIs on `PATH` where the first is older.

This is also relevant to #46: a setup summary that lists what was verified should say which Rigup version the host will actually run.



## #49: Windows validation cannot be reproduced as written: live GitLab probe needs three local fixes, and the handoff and development guide disagree on Node

Source: https://github.com/ansonli-dev/rigup/issues/49

## Problem

I ran the v0.4.1 Windows validation from a clean checkout. The default checks pass. Two parts of the documented validation do not work as written on native Windows.

Environment: Windows 11 (build 26100), NTFS, Node 22.19.0, PowerShell 7, Git for Windows, GitLab CE 19.5.3, GitLab Runner 19.5.2 (checksum matched the official `release.sha256`).

## 1. `test/live-gitlab.test.ts` does not run on Windows without changes

Following [Local GitLab validation](https://github.com/ansonli-dev/rigup/blob/v0.4.1/docs/guides/development.md#local-gitlab-validation), the probe fails in three places, one after another:

| Step | Failure | Cause |
| --- | --- | --- |
| Runner start | `FATAL: homedir variable is not set: "USERPROFILE"` | The runner environment sets `HOME` but not `USERPROFILE`. |
| First job | `ERROR: Job failed: prepare environment: exit status 1` | The runner finds the WSL launcher `C:\Windows\System32\bash.exe` before Git Bash. The test `PATH` is only the Node directory plus the inherited `PATH`. |
| (preventive) | Windows notes say `builds_dir` and `cache_dir` should be relative | The probe writes absolute Windows paths to `runner.toml`. |

With a local copy that adds `USERPROFILE`, puts `C:\Program Files\Git\bin` and `usr\bin` first on the runner `PATH`, and uses relative `builds_dir`/`cache_dir`, the probe passed:

- CI Lint valid, with the generated include resolved.
- Success pipeline with JUnit artifact, failing pipeline with a failing JUnit artifact, and a module-only update that kept both YAML files.
- A missing `RIGUP_MISSING_MODEL_TOKEN` failed `rigup:openwiki`.

So the generated GitLab output works on a Windows runner. Only the probe scaffolding needs fixing.

The probe also deletes its project in `finally`, so a failed job leaves no trace. I had to add a trace capture to find the cause. Keeping the failing job trace in the report would help.

## 2. Node version requirements disagree

- [`external-validation-handoff.md` (W2)](https://github.com/ansonli-dev/rigup/blob/v0.4.1/docs/guides/external-validation-handoff.md) throws `Node.js 24.x required` unless the major version is 24, and C1 does the same.
- [`development.md`](https://github.com/ansonli-dev/rigup/blob/v0.4.1/docs/guides/development.md) says to use 22.19 or later in 22.x, or 24.2 or later, matching `engines`.

All default checks passed on Node 22.19.0 on Windows, and on Node 22.22.1 under WSL2. Either the handoff should accept the supported range or it should say why validation specifically needs 24.

The handoff does give one reason, in its opening paragraph: Node 24.x also satisfies the pinned CodeGraph runtime requirement. That does not require the host Node to be 24. The `npm-shim.js` in `@colbymchenry/codegraph@1.6.2` states that the real work runs on the Node 24 bundled in its per-platform package, and that the user's Node is only a launcher. So the stated reason does not justify the `!== "24"` check.

## Acceptance

- [ ] The live GitLab probe runs on native Windows with the documented environment, or the guide lists the extra setup (Git Bash first on the runner `PATH`, `USERPROFILE`).
- [ ] A failed pipeline keeps the failing job trace, with tokens redacted, in the evidence report.
- [ ] The handoff and the development guide state the same Node requirement.




## #50: update --review reports a conflict in Rigup-owned files after a checkout with core.autocrlf=true, and the message does not mention line endings

Source: https://github.com/ansonli-dev/rigup/issues/50

## Problem

On Windows with Git's default `core.autocrlf=true`, files written by Rigup are LF. After a checkout that converts them to CRLF, `rigup update --review` reports a conflict in files the user never edited. The report says the Rigup-owned block has a local edit and its `nextCommand` points back to the same review command, so nothing tells the user that line endings are the cause.

## Reproduction (Windows 11, Git for Windows 2.51 with `core.autocrlf=true`, published `@ansonli.dev/rigup@0.4.1`, Node 22.19.0)

1. `git init` a project and enable `core.autocrlf=true`. Commit it.
2. `rigup init . --agents claude --sdd none --defer-research --review`, then apply the preview. Commit.
3. Delete the tracked files and run `git checkout -- .` (the same thing a fresh checkout does).
4. `rigup update . --review --json`.

Result: exit 1, `installStatus: conflict`, blocker `CLAUDE.md: Local edit in the Rigup-owned block was preserved. Keep the file as it is, or move your local text outside the managed block and restore the managed text before retrying.` `rigup doctor` also marks `.rigup/.gitignore` as `Local modification preserved` and lists `CLAUDE.md` as pending for the same reason. In a re-run on this machine, `.rigup/rigup-mcp.mjs` and `.mcp.json` were also converted to CRLF but were not flagged: `doctor` reported them as configured, and `update --review` listed only `CLAUDE.md`. A project with generated rules and OpenSpec files shows the same plus the development rules, both `references/project.md` files and the topic page.

| Variation | Result |
| --- | --- |
| Same project checked out with `core.autocrlf=input` (LF) | No conflict (`update --review` exits 3 only because rules are not generated yet) |
| Convert only `CLAUDE.md` back to LF | Conflict clears |
| `.gitattributes` with `text eol=lf` for `CLAUDE.md`, `.mcp.json`, `.rigup/**`, `.claude/**` | CRLF never appears, no conflict |

## Expected

- Line endings alone do not turn Rigup-owned content into a conflict. Comparing the managed block and baseline after normalizing line endings would be enough.
- If a conflict is still reported, the message names line endings when the only difference is CRLF vs LF, and gives a command or a `.gitattributes` suggestion.

## Notes

- Not specific to one file: Rigup-owned text blocks that the checkout converted are affected (`CLAUDE.md`, and `.rigup/.gitignore` in `doctor`). Whole-file and JSON-key owned items (`.rigup/rigup-mcp.mjs`, `.mcp.json`) were not flagged in the re-run above, so the fix should be tested against the block comparison first.
- Teams on Windows often have `autocrlf=true` globally, so this will show up on the first checkout after setup, not only on unusual setups.

## Verification note

Re-checked on Windows 11, Node 22.19.0, a build of the v0.4.1 source with an isolated home directory, `core.autocrlf=true`: after `git ls-files | xargs rm` and `git checkout -- .`, `CLAUDE.md` had CRLF line endings and `update --review --json` returned exit 1 with the conflict above. The same project with `core.autocrlf=input` returned exit 3 (rules pending) and no conflict. The cause is raw string comparison: `equalOwnedContent` in `src/installer/ownership.ts` returns true only for identical text, apart from the JSON and TOML parsing paths.



## #51: WSL2: apply fails on the default /mnt/c mount because every file shows mode 777, and the interrupted install cannot be resumed

Source: https://github.com/ansonli-dev/rigup/issues/51

## Problem

On a WSL2 distro with the default drvfs mount of `C:` (no `metadata` option), `rigup update --apply` writes the project files, then fails because the mode it reads back differs from the previewed `0644`. The failure leaves files in the project but no manifest, and `--resume` cannot recover it. The error does not mention the mount or the file mode, so a user cannot tell what to change.

## Reproduction (Windows 11, WSL2 Ubuntu 26.04, Linux portable package `rigup 0.4.1` installed with `install.sh`)

Project directory under `/mnt/c/...`, path containing a space and Chinese characters (the path is not the cause, see below).

1. `rigup init . --agents claude --sdd none --tools openwiki,codegraph --defer-research --review --json`
2. `rigup update . --apply <previewId> --sessions-ended --json`

Result: exit 1, `written configuration differs from preview (content or mode); baseline not committed`. `.mcp.json`, `CLAUDE.md`, `.rigup/` and `.codegraph/` exist, but:

- `rigup update . --review` exits 1 and `rigup doctor` reports `An approved installation was interrupted. Review the saved preview before resuming.` and `manifest: No installation manifest; no setup performed`.
- `rigup update . --resume --review` produces a new preview, but `--apply <id> --sessions-ended --resume` fails again with `interrupted target content or mode changed; preserve local edits and re-preview`.

## Cause

Default drvfs reports every file as `777`, and `chmod 644` has no effect:

```text
mount: C:\ on /mnt/c type 9p (rw,noatime,aname=drvfs;path=C:\;...)
stat -c %a .mcp.json CLAUDE.md .rigup/rigup-mcp.mjs   -> 777 777 777
cp CLAUDE.md probe.txt; chmod 644 probe.txt; stat -c %a probe.txt   -> 777
```

## Controls

| Location | Result |
| --- | --- |
| Linux home (ext4), same path pattern with space and Chinese | Apply succeeds, modes are 644, CodeGraph initializes, no leftover processes |
| `C:` mounted with `-o metadata` (so modes are stored), same path pattern | Apply succeeds, modes are 644 |

So the failure comes from the mount's mode handling, not from the path.

## Expected

- Before writing, detect that the target filesystem cannot hold the requested mode, and stop with a message that names the mount and suggests a Linux-home checkout or enabling `metadata`.
- If the check runs after writing, either accept the mount's reported mode for files whose previewed mode is `0644`, or make the interrupted state resumable.
- Document the limitation next to the existing WSL guidance in the handoff guide, which already asks for `/mnt/c` to be tested separately.



## #52: A fresh clone of a project that tracks .rigup files stops with 'no trusted baseline' and no next command

Source: https://github.com/ansonli-dev/rigup/issues/52

## Problem

A teammate clones a project where Rigup's setup has been committed (`.rigup/rigup-mcp.mjs` and `.rigup/.gitignore` are tracked). `rigup update --review` in the clone reports a conflict for both files and gives no `nextCommand`:

```text
.rigup/rigup-mcp.mjs: Existing item has no trusted baseline; explicit adoption required
.rigup/.gitignore:   Existing item has no trusted baseline; explicit adoption required
```

`rigup update --help` shows no option for adopting existing files, and `nextCommand` is `null`, so there is no documented action to take.

## Reproduction (Windows 11, Rigup 0.4.1)

1. Apply a foundation setup in a project and commit everything, including `.rigup/rigup-mcp.mjs` and `.rigup/.gitignore`.
2. `git clone` it to a new directory (I tried both `core.autocrlf=true` and `false`; the result is the same, so this is not the line-ending problem).
3. `rigup update <clone> --review --json`.

Result: exit 1, `installStatus: conflict`, two blockers as above, `nextCommand: null`.

## What the docs say

[`usage.md`](https://github.com/ansonli-dev/rigup/blob/v0.4.1/docs/guides/usage.md) (project-level MCP section) says a shared wiring in a new clone can start the service, that research depends on the local machine creating its ownership records, and that if the first preview finds files of unknown ownership you should keep the conflicting files and then review the rebuilt wiring. That describes the situation but not the steps.

## Expected

- The conflict report includes a concrete next step. For example, say that the files match what Rigup would write (when the digests do match) and offer a command that records them as owned on this machine, or tell the user exactly which files to move aside and which command to rerun.
- If the tracked files are byte-identical to the candidate, adopting them should not need a manual step.



## #53: CLI provider (anthropic): a missing count_tokens endpoint or an out-of-range read ends the whole research, and the cause is not shown

Source: https://github.com/ansonli-dev/rigup/issues/53

## Problem

Running research with the CLI provider (`RIGUP_PROVIDER=anthropic`) against an Anthropic-compatible gateway failed in three separate ways. In each case the user saw a short generic message and could not tell which input to change. Two of the causes are not specific to the gateway.

Environment: Windows 11, Node 22.19.0, published `@ansonli.dev/rigup@0.4.1`, a fixture project of 6 small files. The gateway routes a model alias and does not expose the token-counting endpoint. I did not change any repository source. To get past the first two failures I used a local forwarder on `127.0.0.1` and, for the second one, rewrote one model response (called out below).

## 1. `count_tokens` is mandatory and its failure is reported as a generic provider error

Every turn first calls `POST /v1/messages/count_tokens` ([`anthropic.ts`](https://github.com/ansonli-dev/rigup/blob/v0.4.1/src/analyzer/anthropic.ts#L22)). The gateway answers `404 Invalid URL`. Result: exit 1, `provider request failed; research incomplete`. The `catch{}` in [`provider-loop.ts` L71](https://github.com/ansonli-dev/rigup/blob/v0.4.1/src/analyzer/provider-loop.ts#L71) drops the status and body, so a 404, a 403 (model not allowed) and a network error look the same. The run ledger shows `calls: 1, tokens: 0`.

Suggested: include the HTTP status and a short provider message (without the key) in the failure, and fall back to a local estimate, or skip the pre-count, when the endpoint is missing.

## 2. A model-requested read past the end of a file ends the whole research

With count estimates supplied by the forwarder, generation worked and the model started with `list` (paths only), then issued six `read` calls in one turn, each `startLine: 1, endLine: 200`, on files of 1 to 6 lines. The reader rejects an out-of-range end line. I called it directly to confirm:

```text
readEvidence(root, "src/orders/cancel.js", 1, 5)    OK
readEvidence(root, "src/orders/cancel.js", 1, 200)  throws "evidence range beyond file"
```

[`provider-loop.ts` L142](https://github.com/ansonli-dev/rigup/blob/v0.4.1/src/analyzer/provider-loop.ts#L142) turns any read exception into `repository read failed; research incomplete` and stops. The `list` tool does not return line counts, so the model cannot know the range. This does not depend on the gateway.

Suggested: return the read error to the model as a tool result so it can retry, or clamp `endLine` to the file length and say so. Include line counts in `list`.

## 3. A final answer that fails validation ends the run without a cause

One run reached `end_turn` with a JSON answer and was rejected as `provider returned invalid research evidence or structure`. The two `catch{}` blocks around parsing and `validateResearch` in [`provider-loop.ts` L63-64](https://github.com/ansonli-dev/rigup/blob/v0.4.1/src/analyzer/provider-loop.ts#L63-L64) hide why. In a source copy I changed them to print the error; the next attempt passed validation, so I cannot say what the failure was. That attempt completed: 12 generations, preview, apply, development rules and a topic page written, and an unchanged update review returned 0.

Suggested: surface the validation reason (which citation or field) to the user, and allow the final answer to be repaired once.

## 3b. Output token limit per generation: proposed change

The Anthropic Messages API requires `max_tokens` on every request, so Rigup cannot omit it. [`provider-loop.ts` L117](https://github.com/ansonli-dev/rigup/blob/v0.4.1/src/analyzer/provider-loop.ts#L117) sends `Math.min(4096, remaining - inputTokens)`, and the 4096 is fixed. A run that needs a longer answer stops with `research incomplete: provider stopped before completing research`.

Decision: keep the parameter, raise the default to 16384, and make it configurable. The remaining research budget still bounds each request. A value the model does not accept comes back as a provider error, which item 1 makes visible.

I prototyped this in a throwaway working tree and rolled it back, so the repository is unchanged. The prototype touched these files (v0.4.1):

**`src/analyzer/provider-loop.ts`**: add the option, a default and a validator, and use them in place of the literal.

```ts
export interface ProviderOptions {
 // ...existing fields
 /** Output tokens allowed per generation. Anthropic requires a value on every request. */
 maxOutputTokens?:number;
}
export const DEFAULT_MAX_OUTPUT_TOKENS=16384;
export const isValidMaxOutputTokens=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=1;

// in providerBackend(...).run, next to the credential check
const outputCap=options.maxOutputTokens??DEFAULT_MAX_OUTPUT_TOKENS;
if(!isValidMaxOutputTokens(outputCap))throw new Error('model configuration: maximum output tokens must be a positive integer');

// L117
const response=await dispatch(()=>session.generate(Math.min(outputCap,remaining-inputTokens)));
```

**`src/research/provider-settings.ts`**: read the value from `RIGUP_MAX_OUTPUT_TOKENS`, then from `maxOutputTokens` in `~/.config/rigup/provider.json`, and return it on `ResearchProvider`.

```ts
interface PrivateProvider {provider:Provider;model?:string;apiKeyEnv?:string;baseURL?:string;maxOutputTokens?:number}
export interface ResearchProvider {identity:Model;apiKey:string;baseURL:string;maxOutputTokens?:number}
// validate(): accept the new key, require isValidMaxOutputTokens when present

function outputTokenLimit(value:string|undefined):number|undefined{
 if(value===undefined||!value.trim())return;
 const parsed=/^\d+$/.test(value.trim())?Number(value.trim()):NaN;
 if(!isValidMaxOutputTokens(parsed))throw Error('RIGUP_MAX_OUTPUT_TOKENS must be a positive integer');
 return parsed;
}
// in resolveResearchProvider
const maxOutputTokens=outputTokenLimit(process.env.RIGUP_MAX_OUTPUT_TOKENS)??privateSettings?.maxOutputTokens;
return {identity:{provider,model,apiKeyEnv},baseURL,apiKey,...(maxOutputTokens===undefined?{}:{maxOutputTokens})};
```

**`src/lifecycle.ts`** (the `providerBackend({...})` call, L205): pass `maxOutputTokens:services.provider?.maxOutputTokens` next to `apiKey, model, baseURL`. The OpenAI-compatible backend goes through the same loop, so its `max_completion_tokens` follows the same value.

**`docs/guides/usage.md`** (研究后端与预算): add `RIGUP_MAX_OUTPUT_TOKENS` (default 16384, never above the remaining budget), add `maxOutputTokens` to the list of fields the environment overrides, and list it as an optional field of the private provider file.

**`CHANGELOG.md`**: *Raise the default output limit for each CLI provider generation from 4096 to 16384 tokens, and let `RIGUP_MAX_OUTPUT_TOKENS` or `maxOutputTokens` in the private provider file set it. The remaining research budget still bounds each request.*

**Tests**

- `test/backend.test.ts`: with a `fetch` stub that records `max_tokens`, assert the request values for default, `32000`, `500`, and `150000` with a 1000-token budget:

```ts
assert.deepEqual(sent,[16384,32000,500,990]);
for(const bad of [0,-1,1.5,Number.NaN])await assert.rejects(make(bad).run(big,reader),/maximum output tokens/);
```

- `test/provider-cli.test.ts`: with an isolated `HOME`, `resolveResearchProvider` returns `undefined` with nothing set, `24000` from `provider.json`, `48000` once `RIGUP_MAX_OUTPUT_TOKENS` is set (environment wins), and rejects `0`, `-5`, `1.5` and `many` with a message naming `RIGUP_MAX_OUTPUT_TOKENS`.

Result of the prototype on Windows 11, Node 22.19.0: `tsc --noEmit` and `check:docs` passed, and `backend`, `provider-cli` and `openai-compatible` tests passed (49 of 49). In the full suite, 4 tests in `release-npm.test.ts` fail on a clean v0.4.1 tree as well, so they are unrelated.

## 4. Budget counts the pre-count as a call

With `maxCalls: 24`, the successful run recorded `calls: 24, tokens: 91599`, i.e. 12 generations plus 12 pre-counts. A user who sets the number expecting generations gets half of that.

## 5. Model name

The model name in the Claude settings (`claude-auto[1m]`) is rejected by the gateway with `403 This token has no access to model`; `claude-auto` is accepted. Documentation for `RIGUP_MODEL_ID` could say to use the exact name the gateway accepts.

## Related

Comment added on #46 about the gateway inputs (model name, base URL, missing endpoint) the setup summary should show.




## #54: Remove the Windows-only CodeGraph idle-timeout override and its launcher plumbing; use CodeGraph's default

Source: https://github.com/ansonli-dev/rigup/issues/54

## Decision

Rigup should not control the CodeGraph daemon's idle time. Remove the whole mechanism, not only the value: the `3500` default, the `windowsDefaults` parameter, the generated `win32` branch in the project MCP entry, the test that asserts it, and the documentation sentence. CodeGraph's own default applies on every platform.

## Why

Today Rigup shortens the idle time on Windows only, to 3.5 seconds. The Linux/WSL launcher leaves it alone, so the two platforms differ and the difference is undocumented outside one sentence in `usage.md`.

On Linux (WSL2 Ubuntu, Claude Code 2.1.322, CodeGraph 1.6.2) I timed the project's `serve --mcp` process after a non-interactive Claude session that used the CodeGraph MCP tools exited:

| Time after exit | Processes for the project |
| --- | --- |
| +5 s | 1 |
| +65 s | 1 |
| +185 s | 1 |
| +335 s | 0 |
| +425 s | 0 |

The pinned package documents this. [`mcp/daemon.d.ts`](https://registry.npmjs.org/@colbymchenry/codegraph/-/codegraph-1.6.2.tgz) in 1.6.2: *"When the last client disconnects the daemon lingers for `CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS` (default 300s) so back-to-back agent runs in the same project don't repay startup, then exits cleanly."* and `daemon.js` has `DEFAULT_IDLE_TIMEOUT_MS = 300_000`. That file is not in the main package tarball linked above (which ships only declarations and `npm-shim.js`). It is in the per-platform package, for example `@colbymchenry/codegraph-win32-x64/lib/dist/mcp/daemon.js` line 96 in the 1.6.2 install on Windows. So the residual process is CodeGraph's intended behavior, and Rigup was working around it only on Windows (the change that closed #16).

## Where it lives (v0.4.1)

- [`src/integrations/registry.ts` L77-78](https://github.com/ansonli-dev/rigup/blob/v0.4.1/src/integrations/registry.ts#L77-L78): `windowsDefaults = tool.id==='codegraph' ? {CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS:'3500'} : undefined`, passed into `projectMcpArgs`.
- [`src/integrations/tools/project-mcp-entry.ts` L30-32](https://github.com/ansonli-dev/rigup/blob/v0.4.1/src/integrations/tools/project-mcp-entry.ts#L30-L32): the `windowsDefaults` parameter and the generated prefix `if(process.platform==='win32')for(const [key,value] of Object.entries(...))process.env[key]??=value;`. It is the only user of the parameter; `projectMcpArgs` can return the plain entry script.
- [`test/integrations.test.ts` L142-157](https://github.com/ansonli-dev/rigup/blob/v0.4.1/test/integrations.test.ts#L142-L157): the shim records `process.env.CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS`, the test deletes that variable before running, expects `{idle:'3500'}` on win32, and asserts the generated script matches `/process\.platform==='win32'.*CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS/s`. The variable and those assertions go away; keep the rest (project-local tool resolution from a moved, nested working directory).
- [`docs/guides/usage.md` L150](https://github.com/ansonli-dev/rigup/blob/v0.4.1/docs/guides/usage.md#L150): *"Windows 的项目内 MCP 入口默认将共享 daemon 空闲时间缩短为 3.5 秒 ... 已启动的 daemon 在重启后读取新的设置。"* Remove these sentences. Keep the advice to wait for the process to exit before moving or reinstalling the tool directory, and mention the default of about five minutes.
- `CHANGELOG.md` has the earlier entry ("Shorten the idle timeout for project-local CodeGraph on Windows"). Leave history as is and add a line in the release that removes it.

A search of `src`, `test`, `docs`, `templates`, `scripts` and the READMEs for `IDLE_TIMEOUT`, `windowsDefaults` and `3500` finds nothing else. Historical evidence files under `docs/compatibility/` describe the daemon policy and need no change.

## Effect on existing projects

Every platform's generated CodeGraph entry contains the `win32` snippet text (it is guarded at runtime), so after this change `rigup update --review` will show the managed `mcpServers.codegraph` entry in `.mcp.json` (and the equivalent Codex/OpenCode/OMP targets) as a managed-entry change on all platforms. It should apply through the normal protected update path with no conflict. Worth checking explicitly: a project created with 0.4.1, then updated, then an unchanged review returning 0.

## Consequence to accept

On Windows the project-local CodeGraph daemon can keep files under `.rigup/tools/codegraph` open for up to about 300 seconds after the last client disconnects. That is why #16 asked for the short timeout. After this change, moving or reinstalling that directory right after a session may need a wait, or stopping the daemon with `codegraph daemon`. CodeGraph's own fixture cleanup in the tests (`stopFixtureCodeGraph` in `test/native-tools-support.ts`) already stops daemons explicitly and is not affected. Please check any Windows live probe that deletes a fixture immediately after a Claude session ends.

## Acceptance

- [ ] No reference to `CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS`, `windowsDefaults`, or a `win32` branch for CodeGraph remains in `src`, `test` and the guides.
- [ ] The generated CodeGraph MCP entry is identical to the generic project entry apart from its target path and arguments.
- [ ] The project-local tool resolution test still passes from a moved, nested directory.
- [ ] On an existing 0.4.1 project, `update --review` reports only the managed entry change, `--apply` succeeds, and a following review is unchanged.
- [ ] The documentation states that the daemon exit timing is CodeGraph's default.

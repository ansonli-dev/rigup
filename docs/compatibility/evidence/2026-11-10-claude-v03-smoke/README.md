# Claude Code smoke evidence for Rigup v0.3.x

Recorded November 10, 2026 for [issue #29](https://github.com/ansonli-dev/rigup/issues/29). Paths, account details, and preview IDs are omitted or replaced with placeholders.

## macOS arm64, Rigup v0.3.2

Directly observed on macOS 27.0.1 arm64 with Node.js 24.15.0, npm 11.12.1, Claude Code 2.1.273, and OpenSpec 1.16.0. The Rigup CLI came from a prior isolated install of the public npm package. Its release manifest identifies source commit `bd50d87f214548e583e5e677007c1c8a827dfd59`. [Rigup v0.3.2 release](https://github.com/ansonli-dev/rigup/releases/tag/v0.3.2)

The project was a fresh copy of `test/fixtures/live/service` in a directory with Unicode characters and a space. `HOME` and `CLAUDE_CONFIG_DIR` pointed to a disposable configuration with `enableAllProjectMcpServers: true`. The generated Rigup stdio entry was the fixture's only MCP server.

1. `sw_vers -productVersion`, `uname -sm`, `node --version`, `npm --version`, `rigup --version`, `openspec --version`, and `claude --version` each exited 0 and returned the environment versions above.
2. `git init -q` and `openspec init --tools claude .` both exited 0. OpenSpec prepared the native Claude workflow entries.
3. `rigup init . --agents claude --sdd openspec --tools none --defer-research --review --json` exited 3 with `phase: handoff`, `installStatus: pending`, and `projectRules: pending`. It returned a preview for the foundation setup.
4. `rigup update . --apply PREVIEW_ID --sessions-ended --json` exited 0 with `installStatus: complete`, eight writes, and `projectRules: pending`.
5. `claude mcp get rigup` and `claude mcp list` each exited 0 and showed Rigup connected, both from the fixture root and from `src/`. The `get` output identified project scope via `.mcp.json`. Claude's MCP logs recorded successful stdio connections.
6. `rigup doctor . --check-host claude --json` reported `mcp:claude:rigup` configured and `claude:load` passed. Doctor exited 3 with project rules still pending.
7. `rigup update . --review --json` exited 3 in the research phase with project rules pending and a host MCP handoff.

The first preview attempt exited 1 with `spawn EPERM` because the command sandbox blocked the system `ps` that Rigup uses for process identity. The successful retry ran in the same disposable fixture with access to the system `ps`. The checks exercised native Claude MCP discovery and the deferred OpenSpec foundation, with zero model requests. Model-driven tool calls, rule acceptance, and an unchanged review after applying generated rules remain unverified on macOS.

The November 9 v0.3.0 report also records Claude Code 2.1.319 connecting to Rigup MCP on macOS arm64 from the Unicode and space fixture root, a subdirectory, and the equivalent locations in a fresh clone. The retained Claude logs corroborate four stdio connections. The report preserves the scope and outcome, and the retained MCP logs do not preserve the original shell command lines. [v0.3.0 validation report](../../validation-0.3.0.md)

## Windows 11 arm64, Rigup v0.3.2

Directly observed in a Windows 11 arm64 VM, build 26300, with PowerShell 7.6.9, Node.js 22.19.0 x64, npm 10.9.3, Claude Code 2.1.322 x64, and OpenSpec 1.16.0. Rigup came from the same public v0.3.2 npm package used on macOS. [Rigup v0.3.2 release](https://github.com/ansonli-dev/rigup/releases/tag/v0.3.2)

The probe used a new one-file Git project in a directory with Unicode characters and a space. It used a separate npm prefix and cache, disposable user and Claude configuration, and `enableAllProjectMcpServers: true`. Rigup was the only MCP server in the fixture.

1. `npm install --prefix PREFIX --ignore-scripts --no-audit --no-fund --no-save --registry https://registry.npmjs.org/ @ansonli.dev/rigup@0.3.2 @fission-ai/openspec@1.16.0 @anthropic-ai/claude-code@2.1.322` exited 0. The first attempt stopped before launching Claude because the executable lookup had selected the npm wrapper. The retry added `--offline`, exited 0, and selected `@anthropic-ai/claude-code-win32-x64/claude.exe` directly. Windows validated its Anthropic Authenticode signature, and its SHA-256 matched Anthropic's signed release manifest. [Claude Code binary verification](https://code.claude.com/docs/en/setup#binary-integrity-and-code-signing)
2. `node -p 'process.version+String.fromCharCode(32)+process.platform+String.fromCharCode(32)+process.arch'`, `rigup --version`, `claude --version`, `openspec --version`, and `npm --version` returned the versions above. `git init -q` and `openspec init --tools claude .` each exited 0.
3. `rigup init . --agents claude --sdd openspec --tools none --defer-research --review --json` exited 3 with `phase: handoff` and `projectRules: pending`. It returned a foundation preview.
4. `rigup update . --apply PREVIEW_ID --sessions-ended --json` exited 0 with `installStatus: complete`, eight writes, and `projectRules: pending`.
5. `claude mcp get rigup` and `claude mcp list` each exited 0 and showed Rigup connected from both the fixture root and `src/`. The `get` output identified project scope via `.mcp.json`.
6. `rigup doctor . --check-host claude --json` reported `mcp:claude:rigup` configured and `claude:load` passed. Doctor exited 3 with project rules pending.
7. `rigup update . --review --json` exited 3 in the research phase with project rules pending.

This run exercised native Windows MCP discovery and deferred foundation setup with zero model requests. Model-driven tool calls, rule acceptance, and an unchanged review after applying generated rules remain unverified for v0.3.2 on Windows.

## Windows 11 x64, Rigup v0.3.1

External reporter evidence from November 10, 2026. The reporter used npm-installed Rigup 0.3.1, Windows 11 x64 build 26100, PowerShell 7.6.6, Node.js 22.19.0, Claude Code 2.1.322, and OpenSpec 1.16.0. The report identifies the package by version. [Windows reproduction](https://github.com/ansonli-dev/rigup/issues/19)

1. Set up a fresh Git project with `test/fixtures/live/service` and ran `rigup init . --agents claude --sdd openspec --prepare-openspec --sessions-ended`.
2. Ran `rigup init . --agents claude --sdd openspec --tools none --defer-research --review` and applied its preview with `rigup update . --apply PREVIEW_ID --sessions-ended`. The next `rigup update . --review` exited 3 with rules pending.
3. In Claude Code, the reporter described running the Rigup MCP flow from `rigup_begin` through plan, page, acceptance, and `rigup_finish`. The reported `rigup update . --apply PREVIEW_ID --sessions-ended` succeeded with `projectRules: ready`.
4. The next `rigup update . --review --json` failed in preflight with exit 1. The error was `dangling or escaping navigation link: .claude/skills/change-prepare/SKILL.md -> references/project.md`. The reporter observed the file on disk and configured in doctor. The same failure occurred in a project originally set up with v0.3.0.

The report gives the lifecycle and final error but leaves individual setup exit codes, the Claude prompt, the ordered tool transcript, and usage unrecorded. Rigup v0.3.2 lists a fix for the retained OpenSpec reference. Independent Windows confirmation of an unchanged review after applying Claude-generated rules remains pending. [Rigup v0.3.2 changelog](https://github.com/ansonli-dev/rigup/blob/v0.3.2/CHANGELOG.md)

## Model validation

On the macOS host used for the v0.3.2 smoke, the redacted result of `claude auth status --json` was exit 1, `loggedIn: false`, `authMethod: none`, and `apiProvider: firstParty`. The local Claude help lists `--max-budget-usd` for print mode. Anthropic documents it as a stop threshold based on the client's estimated spend and says the threshold can be exceeded. [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)

The live MCP generation run requires working Claude authentication and an agreed spend limit. The harness preflight itself sends a model request. The matrix is deferred pending the harness spend caps, partial-cost accounting, working authentication, and an agreed total ceiling. [Issue #29 budget gate](https://github.com/ansonli-dev/rigup/issues/29#issuecomment-6763494036)

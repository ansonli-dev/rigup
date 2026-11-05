# Rigup

[![CI](https://github.com/ansonli-dev/rigup/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ansonli-dev/rigup/actions/workflows/ci.yml) · [v0.1.0 development preview](https://github.com/ansonli-dev/rigup/releases/tag/v0.1.0) · [简体中文](README.zh-CN.md)

Rigup sets up coding-agent workflows for an existing repository. It prepares project guidance from source evidence, connects the tools you select, and lets you review changes before applying them.

[Quick start](#quick-start) · [Integrations](#integrations) · [Commands](#commands) · [Documentation](https://github.com/ansonli-dev/rigup/blob/main/docs/README.md)

## Quick start

### 1. Install

```sh
curl -fsSL --proto '=https' https://raw.githubusercontent.com/ansonli-dev/rigup/main/install.sh | sh
```

The installer selects the macOS or Linux build for ARM64 or x64, verifies its checksum, and links the command into `~/.local/bin`. The portable build includes Node.js. If `rigup` is missing from PATH, run `export PATH="$HOME/.local/bin:$PATH"`. Use Git and `ps` on the host. Linux needs glibc 2.35 or newer, including when using WSL2. [Manual downloads and platform checks](docs/guides/releases.md)

With Node.js 24 and npm, install the published package globally.

```sh
npm install -g @ansonli.dev/rigup
```

### 2. Set up a project

```sh
cd /path/to/project
rigup init
```

The guide asks for missing agent, workflow, and tool choices. Local Codex is the default research backend and uses your existing Codex login for semantic research. Pass a choice such as `--agents codex` to preselect it. This non-interactive preview uses local defaults and makes zero model calls.

```sh
rigup init --agents codex --sdd none --tools none --dry-run --json
```

### 3. Review and use the installed workflow

In review mode, inspect the preview and end any affected agent sessions. Run the reported `nextCommand` from a separate terminal, then reopen the agent. Where a native workflow is configured, start with the installed `change-prepare` and `change-deliver` skills. `rigup doctor` reports setup and reload status. [Apply and recovery](docs/guides/usage.md#应用与恢复)

## Integrations

- Agent adapters cover Codex, Claude Code, OpenCode, and Oh My Pi. For Superpowers, OpenSpec, or Spec Kit, prepare the official entry points first. Rigup binds the selected workflow to its native steps and approval gates. [Tested combinations](docs/compatibility/status.md)
- Optional tools include CodeGraph and OpenWiki. Rigup stages and verifies the CodeGraph index. OpenWiki setup connects MCP and gives you the separate wiki generation step. [Tool setup](docs/guides/usage.md#openwiki-和-codegraph)
- Skills, MCP runners, hooks, and CI checks are installed according to your selections. Node-based assets use Node on the consuming agent or CI PATH. Protected updates compare the last installed baseline, local edits, and the new candidate. [Configuration and update behavior](docs/guides/usage.md)

## Commands

```sh
rigup                    # Open the project menu in a terminal
rigup init               # Set up the current project
rigup update --review    # Prepare a reviewable update
rigup update --configure # Reopen the setup guide
rigup doctor             # Inspect setup status
rigup --help             # Show all options
```

`init`, `update`, and `doctor` are subcommands. Pass a project path after the command to work in another directory. Use options such as `--review` and `--json` to choose execution mode or output.

## Contribute

Run `npm ci` and `npm run check` from the source checkout. [Development](docs/guides/development.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

[MIT](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)

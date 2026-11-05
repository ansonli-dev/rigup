# Rigup

[简体中文](README.zh-CN.md) · [Documentation](https://github.com/ansonli-dev/rigup/blob/main/docs/README.md) · [Validation](docs/compatibility/status.md)

Rigup sets up coding-agent workflows in an existing project. It uses repository evidence to prepare skills, MCP connections, hooks, and CI checks. Preview the changes before applying them, then use the same workflow to update installed assets alongside local edits.

## Install

The v0.1.0 development preview ships with Node.js for macOS and Linux on ARM64 and x64. Download the archive or use the installer below. [GitHub Releases](https://github.com/ansonli-dev/rigup/releases/tag/v0.1.0) · [Installation guide](docs/guides/releases.md)

```sh
curl -fL --proto '=https' -o rigup-install.sh https://github.com/ansonli-dev/rigup/releases/download/v0.1.0/install.sh &&
  sh rigup-install.sh
export PATH="$HOME/.local/bin:$PATH"
```

## Start a project

```sh
cd /path/to/project
rigup init
```

The terminal guide asks for missing choices. Codex is the default agent and research backend. Pass `--agents codex` to preselect the agent, or provide all choices for automation. This example previews a setup with local defaults and makes zero model calls.

```sh
rigup init --agents codex --sdd none --tools none --dry-run --json
```

Use `rigup update --review` to review later changes and `rigup doctor` to inspect the project. Follow the reported apply command from a separate terminal after ending affected agent sessions. See the [usage reference](docs/guides/usage.md).

## Contribute

Run `npm ci` and `npm run check` in the source checkout. [Development guide](docs/guides/development.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

[MIT](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)

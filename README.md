# Rigup

[简体中文](README.zh-CN.md) · [Documentation](https://github.com/ansonli-dev/rigup/blob/main/docs/README.md) · [Validation status](docs/compatibility/status.md)

Rigup prepares project-specific workflows for coding agents. It reads repository evidence, generates candidates, previews changes, and installs skills, MCP connections, hooks, and CI scripts with protected updates. Installed assets run independently of the Rigup CLI.

**0.1.0 is a development preview, installed from source.** Local Codex is the default research backend. Configuration adapters exist for Claude Code, Codex, OpenCode, and Oh My Pi, with Superpowers, OpenSpec, and Spec Kit entry points. Actual discovery, model behavior, and workflow gates are verified separately; see [tested scope and remaining prerequisites](docs/compatibility/status.md).

## Install

Requires Node.js 24+, npm, Git, a POSIX shell, and `ps` (`procps` on minimal Linux images). Semantic research also requires an authenticated Codex CLI. This project has not published an npm registry release; install this repository rather than an unrelated package with the same name.

```sh
git clone https://github.com/ansonli-dev/rigup.git
cd rigup
npm ci
npm run build
npm link
rigup --help
```

Run `npm link` once in the source checkout to register the `rigup` command on your npm prefix's PATH. Keep the checkout available; rebuild after source updates. You can also run the built CLI directly with `node /path/to/rigup/dist/cli.js`.

## Use

Run this from the project root in an interactive terminal:

```sh
cd /path/to/project
rigup init
```

The guide asks for missing agents, SDD, optional tools, and the research backend, then offers continuous, review, or dry-run mode. Codex is the suggested agent/backend; select another in the guide. Running `rigup` alone opens the project menu.

Arguments are optional. Supply some to preselect those choices and let the guide fill the rest, or supply everything for scripts:

```sh
rigup init --agents codex
rigup init --agents codex --sdd openspec --dry-run --json
rigup init /path/to/another-project --agents codex --sdd openspec --review --json
```

Omitting the path uses the current directory. `--json` and non-interactive input do not prompt; provide the selections they need. The selected SDD must have its official entry points installed; missing prerequisites remain actionable pending items. `--dry-run` stores private candidates and a preview without installing project assets.

Review concrete changes, end agent sessions that load affected assets, then run the reported `nextCommand` from an independent terminal. Later commands also default to the current project:

```sh
rigup update
rigup update --configure
rigup doctor
```

Tool-only setup needs neither an SDD nor model calls:

```sh
rigup init --agents codex --sdd none --tools openwiki,codegraph --review --json
```

OpenWiki setup installs the software, registers MCP, and provides a separate initialization guide. Start its long-running wiki generation as a separate task. CodeGraph initialization uses isolated staging, integrity checks, and recoverable installation.

## How it protects a project

- Updates compare the previously installed baseline, current user files, and new candidates. Conflicts remain reviewable; previews bind the approved inputs and operations.
- Research filters sensitive files and records source references, unknowns, and cumulative usage. Later Codex stages receive task-relevant evidence; dependency lock bodies are omitted while their fingerprints still invalidate caches.
- Native workflow gates stay with the selected SDD. Tool execution comes from pinned recipes and explicit configuration.
- Installed skills, MCP runners, hooks, and CI scripts keep working after Rigup is removed.

See the [usage reference](docs/guides/usage.md) for configuration, budgets, backends, recovery, and exit codes. Codex usage limits are checked from observed usage; they are not a provider-enforced hard token ceiling.

## Develop and contribute

```sh
npm ci
npm run check
```

The check runs contract tests, type checking, build, documentation links, and an isolated package-consumer smoke test. It does not call paid models. For Claude on another machine and native Windows/WSL2 testing, use the [external validation handoff](docs/guides/external-validation-handoff.md) (中文). See [development and opt-in integration tests](docs/guides/development.md), [contributing](CONTRIBUTING.md), [security reporting](SECURITY.md), and the [changelog](CHANGELOG.md).

## License

[MIT](LICENSE). Integrations and dependencies retain their own [licenses and notices](THIRD_PARTY_NOTICES.md).

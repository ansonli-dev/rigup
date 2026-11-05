# Changelog

## 0.1.1 · 2026-11-05 · Development preview

- Publish the verified release tarball to npm from GitHub Actions using Trusted Publishing.
- Read `rigup --version` from the installed package so it follows the release version.
- Document npm installation, upgrades, and release recovery.

[npm package](https://www.npmjs.com/package/@ansonli.dev/rigup/v/0.1.1) · [Release downloads](https://github.com/ansonli-dev/rigup/releases/tag/v0.1.1)

## 0.1.0 · 2026-11-05 · Development preview

- Publish the CLI as `@ansonli.dev/rigup` on the public npm registry.
- Ship portable `rigup` commands for macOS and Linux on ARM64 and x64, with an installer, SHA-256 checksums, and a compiled npm tarball.
- Guide missing choices in project-root `rigup init`. Bind the selected host and SDD to their native entry points.
- Use local Codex by default. Filter sensitive files, send evidence scoped to each generation stage, and retain usage across retries.
- Preview and apply protected updates with three-way comparison, ownership tracking, and interrupted-operation recovery.
- Install standalone skills, MCP runners, hooks, and CI checks. Initialize CodeGraph through protected staging and hand off OpenWiki generation to a separate session.

[npm package](https://www.npmjs.com/package/@ansonli.dev/rigup) · [Release downloads](https://github.com/ansonli-dev/rigup/releases/tag/v0.1.0) · [Validation scope](docs/compatibility/status.md)

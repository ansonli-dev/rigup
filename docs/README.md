# Documentation

Start with the [English README](../README.md) or [中文说明](../README.zh-CN.md).

## Using Rigup

- [Usage reference](guides/usage.md): configuration, backends, research budgets, protected updates, recovery, integrations, and exit codes. This detailed reference is currently in Chinese.
- [Current validation status](compatibility/status.md): tested scope and external prerequisites.
- [External validation handoff](guides/external-validation-handoff.md) (中文): Claude on another machine, native Windows/WSL2, pass criteria, budgets and recovery.
- [Development and testing](guides/development.md): repeatable checks, opt-in integration tests, architecture map, and release checklist.
- [Contributing](../CONTRIBUTING.md), [security reporting](../SECURITY.md), [changelog](../CHANGELOG.md), and [third-party notices](../THIRD_PARTY_NOTICES.md).

## Design and evidence

These records explain decisions and preserve history. A historical proposal or unchecked plan is not a current support guarantee; current behavior is described in the usage guide and validation index.

- [Requirements](https://github.com/ansonli-dev/rigup/blob/main/docs/requirements/2026-11-02-rigup-requirements.md).
- [Architecture](https://github.com/ansonli-dev/rigup/blob/main/docs/superpowers/specs/2026-11-02-rigup-design.md), [CLI interaction](https://github.com/ansonli-dev/rigup/blob/main/docs/superpowers/specs/2026-11-03-cli-interaction-design.md), and [documentation responsibilities](https://github.com/ansonli-dev/rigup/blob/main/docs/superpowers/specs/2026-11-03-documentation-system-design.md).
- [Upstream verification policy](https://github.com/ansonli-dev/rigup/blob/main/docs/compatibility/README.md) and [pinned sources](compatibility/upstream-lock.json).
- [Historical validation ledger](https://github.com/ansonli-dev/rigup/blob/main/docs/compatibility/verification.md): dated observations, failures, repairs, and source-bound evidence.
- [Open source preparation references](https://github.com/ansonli-dev/rigup/blob/main/docs/research/2026-11-05-open-source-practices.md).

- [Project-root CLI terminal verification](compatibility/evidence/2026-11-05-simple-cli-entry/README.md): real registered command, interactive/no-argument/partial-argument paths, review fixes and model-free checks.

# Security policy

Rigup's 0.1.0 development line is the current maintenance target. No stable release or guaranteed response time is offered yet. Use the latest reviewed source commit and consult [validation status](docs/compatibility/status.md) for integration limits.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/ansonli-dev/rigup/security/advisories/new) when it is enabled. If GitHub reports that private reporting is unavailable, open a minimal [issue](https://github.com/ansonli-dev/rigup/issues/new) requesting a private contact channel; omit vulnerability details until a maintainer provides one. Never post credentials, exploitable details, customer source, or full research exchanges in a public issue.

Include the affected commit/version, operating system, a sanitized reproduction, expected protection, actual effect, and whether a workaround is available. Prefer a disposable fixture over a customer repository.

## Trust boundaries

- Rigup reads project files and can install project configuration, executable hooks, MCP runners, and pinned optional tools. Review the concrete preview and explicit check commands before applying them.
- The read policy excludes known credential containers (including `.auth`, `.netrc`, `.npmrc`, and credential backups), rejects private-key material, and filters sensitive configuration values, comments, cookies and browser storage. Selected project evidence is still sent to the chosen research provider; inspect the scope and use the provider under your organization's policy. Source comments and generated content are untrusted inputs, not installation authority.
- Keep credentials in environment references. Command validation recognizes common authentication flags and headers; use references for credentials even when a custom client uses an unrecognized flag. Do not place token values in `.rigup/config.yaml`, URLs, command arguments, templates, bug reports, or public evidence.
- Checks and installed third-party tools execute code. Use trusted projects, dependencies, SDD entry points, and tool providers. A successful local contract test is not a guarantee that arbitrary external tools are safe.
- Preview binding, ownership checks, and recovery receipts protect declared operations. Unknown live writers or unreconciled side effects stop automatic recovery rather than being silently discarded.
- These checks do not provide OS isolation against another process running as the same user or against a modified installed dependency. Protect the runtime and state directory with an appropriate operating-system boundary when that threat applies.
- Codex cumulative budgets use observed provider usage; they do not impose a provider-side hard token limit. Retain durable state when resuming a failed or interrupted run.

For ordinary operational recovery, see the [usage guide](docs/guides/usage.md). Dependency vulnerabilities are checked with `npm audit`; CI runs credential-free checks with read-only repository permissions.

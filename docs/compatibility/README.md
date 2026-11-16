# Upstream verification

[`upstream-lock.json`](upstream-lock.json) records the last verified combinations, including exact versions or commits, official sources, package integrity, and native entry points. Record new combinations after verifying them. Rigup checks user-installed entry points and resolves the selected registry's `latest` tag when it needs to install a package. An approved preview or a verified local receipt supplies the package identity for subsequent operations.

For each integration change, record the official command and configuration, runtime prerequisites, write scope, identity checks, and recovery method. Test ownership and failure handling before enabling the operation. For native tools, verify software installation, project initialization, and actual client use separately.

Record results by tested commit, version, platform, and scenario. Source inspection, contract tests, and live runs provide distinct evidence. Keep private exchanges and credentials in the test environment and publish sanitized receipts under `docs/compatibility/evidence/`.

[Current validation status](status.md) · [Live testing](../guides/development.md#opt-in-integrations)

# Upstream verification

[`upstream-lock.json`](upstream-lock.json) records the last verified combinations, including exact versions or commits, official sources, package integrity, and native entry points. Record new combinations after verifying them. An approved preview or a verified local receipt supplies the package identity for subsequent operations.

## Native Superpowers preparation

`rigup init --agents claude,omp --sdd superpowers --prepare-native` reuses any installation that the native scan recognizes. Ordinary integration checks and `rigup doctor` use local discovery. When OMP needs a user link, the preparation preview resolves the official npm `latest` tag and displays the exact version, archive URL, and SHA-512 integrity. The approved archive is verified before it enters Rigup's store. If the Claude project plugin supplies OMP's required entries, the OMP link is skipped.

Claude preparation uses the cached official marketplace entry's SHA and any version it declares. Adding a fresh marketplace requires approval in a terminal. Rigup then displays the resolved plugin target for a separate approval. The scoped install receipt and a fresh native scan verify the result. Rigup probes the installed CLI after approval and reports differences from the last verified version as it proceeds.

`--review`, `--dry-run`, and `--json` display preparation without host writes. `nativePreparation.blockers` lists unresolved conditions with evidence and any suggested commands. An OMP rescan failure includes the intended destinations, detected path-related `.env` key names, and relevant config locations. Rigup reports `.env` key names and leaves values to the host. Review the evidence and approve any repair through the host, then rerun preparation.

For each integration change, record the official command and configuration, runtime prerequisites, write scope, identity checks, and recovery method. Test ownership and failure handling before enabling the operation. For native tools, verify software installation, project initialization, and actual client use separately.

Record results by tested commit, version, platform, and scenario. Source inspection, contract tests, and live runs provide distinct evidence. Keep private exchanges and credentials in the test environment and publish sanitized receipts under `docs/compatibility/evidence/`.

[Current validation status](status.md) · [Live testing](../guides/development.md#opt-in-integrations)

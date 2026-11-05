# Binary release verification — 2026-11-05

[Rigup v0.1.0](https://github.com/ansonli-dev/rigup/releases/tag/v0.1.0) is a public development preview built from `1c63658108bc1ffcc5f937b90c5ecc902310923d`. The tag workflow passed macOS 15 and Ubuntu 22.04 on ARM64 and x64. It published four portable archives, an installer, the compiled npm tarball, the manifest, and checksums.

- [Release run](release-run.json) records the build-only matrix, source CI, tag workflow, and public asset URLs. The first publisher created a draft before it was visible to the release listing. Rerunning the failed job with the original artifacts recovered the draft and verified all uploads. The follow-up on `main` adds a bounded retry for draft discovery.
- [Published manifest](release-manifest.json) and [SHA-256 checksums](SHA256SUMS) bind the binaries to their actual build and smoke receipts. The Apple Silicon runner also exercised the pinned native tool installation and CodeGraph query.
- [Anonymous portable smoke](anonymous-portable.json) covers the published Apple Silicon bytes through extraction, relocation, PATH lookup, preview/apply, no-op update, doctor, and standalone MCP runner execution. The published installer and compiled npm tarball also installed successfully in isolated user directories.
- [Anonymous installed terminal checks](anonymous-terminal.json) cover no-argument project-root `rigup init` with Codex defaults, dry-run, Ctrl-C and EOF on a real TTY. The command ran with neither Node nor npm on the starting PATH.
- [Independent review and repairs](review.json) records the installer symlink issue and first-run Linux fixture failure. [Distribution decisions](decisions.md) records the platform, runtime, and publishing boundaries.

## Local prototypes

- [Portable macOS ARM64 lifecycle](local-portable.json): official pinned Node24.22.2, no system Node/npm on the CLI PATH, relocation with spaces/quotes and PATH symlink, preview/apply/session handoff/no-op/doctor. The standalone MCP runner passed after removing the Rigup application with an explicitly provided consumer Node.
- [Actual pinned native tools](local-native.json): OpenWiki0.7.3 and CodeGraph1.6.2 installed using the portable runtime/npm; CodeGraph initialized and returned a business symbol. An unchanged update did not reinitialize. OpenWiki generation remained separate; no model call.
- [Initial fixture reconciliation](local-native-reconciliation.json): the upstream CodeGraph shell launcher needed the standard POSIX dirname utility omitted from the isolated test PATH. Restoring that utility recovered the original query without reinstalling; project-scoped daemon shutdown was verified before cleanup. Product guards were unchanged.
- [Installer against the full portable archive](local-installer.json) covers the real download over loopback, checksum verification, first install, repeat install and project-root preview without system Node on PATH. Nine installer regressions cover safe version selection and failure handling, including a link whose managed target has been replaced with a directory.

The prototype digest binds these local observations. `source.dirty=true` identifies those artifacts as local candidates. See the [external validation handoff](../../../guides/external-validation-handoff.md) for the Windows, WSL2, and model-provider checks.

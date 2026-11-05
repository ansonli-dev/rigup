# Binary release verification — 2026-11-05

Implementation is in progress; these are source-bound local candidate checks, not a published release claim.

- [Portable macOS ARM64 lifecycle](local-portable.json): official pinned Node24.22.2, no system Node/npm on the CLI PATH, relocation with spaces/quotes and PATH symlink, preview/apply/session handoff/no-op/doctor. The standalone MCP runner passed after removing the Rigup application with an explicitly provided consumer Node.
- [Actual pinned native tools](local-native.json): OpenWiki0.7.3 and CodeGraph1.6.2 installed using the portable runtime/npm; CodeGraph initialized and returned a business symbol. An unchanged update did not reinitialize. OpenWiki generation remained separate; no model call.
- [Initial fixture reconciliation](local-native-reconciliation.json): the upstream CodeGraph shell launcher needed the standard POSIX dirname utility omitted from the isolated test PATH. Restoring that utility recovered the original query without reinstalling; project-scoped daemon shutdown was verified before cleanup. Product guards were unchanged.
- [Installer against the full portable archive](local-installer.json) covers the real download over loopback, checksum verification, first install, repeat install and project-root preview without system Node on PATH. Nine installer regressions cover safe version selection and failure handling, including a link whose managed target has been replaced with a directory.

The prototype archive digest binds these observations; source.dirty=true explicitly identifies a local candidate. Final clean native runner builds, checksums and the actual published release will be recorded separately. These results do not promote Windows, WSL2 native clients, paid provider sessions or long wiki generation to passed.

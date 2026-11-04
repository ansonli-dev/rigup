# Open source readiness and local closure

User request, 2026-11-05: finish work that can be developed, tested, reviewed and fixed locally; record only issues that require unavailable external conditions; prepare professional open source documentation; commit and push when checks pass.

## Acceptance

- Preserve existing behavior and user-authored design changes. Bring the intended Rigup document renames into a coherent, linked source tree.
- Give a new contributor an accurate introduction, reproducible source installation, safe first run, development/test instructions, support boundaries, contribution/security reporting paths, license and release history.
- Consult primary sources from established open source projects. Adapt their organization, without copying their claims or prose.
- Keep npm publication disabled until separately requested. The GitHub repository can be public while the package remains source-install only.
- Run the full offline test suite, type checking, build, dependency/security checks, clean packaged installation, and the locally available real integrations. Add regressions before fixing behavior. Do not invent credentials or erase previous paid usage. Existing semantic E2E evidence stays attributable to its tested source.
- CI repeats credential-free checks on macOS and Linux, with least privilege and immutable action versions. CI does not run paid models or OpenWiki generation on pull requests.
- OpenWiki installation/MCP registration and its separate initialization guide remain the scope of setup. CodeGraph protected initialization and recovery remain supported.
- Default model/agent is Codex. Other providers may remain blocked on the user's other machine. Explicitly name prerequisites and resume steps for every remaining external validation gap; do not imply full compatibility from static adapters.
- Review the entire branch with one fresh reviewer, fix actionable local defects, verify the final source, then commit and push without another confirmation. Do not publish an npm package, deploy an application, or change repository visibility.

# Validation status

## Verified scenarios

- **Distribution.** Rigup v0.2.0 passed the release smoke checks on macOS 15 and Ubuntu 22.04 on ARM64 and x64. Its npm archive integrity matches the verified release manifest. The v0.1.0 Apple Silicon bundle also passed interactive `rigup init` and standalone MCP execution with consumer Node. [v0.2.0 release](https://github.com/ansonli-dev/rigup/releases/tag/v0.2.0) · [Release workflow run](https://github.com/ansonli-dev/rigup/actions/runs/42099562726) · [v0.1.0 evidence](https://github.com/ansonli-dev/rigup/tree/main/docs/compatibility/evidence/2026-11-05-binary-releases)
- **Codex and native tools.** Codex 0.166.0 loaded installed skills and MCP. On macOS ARM64 and clean Linux ARM64, the protected tool flow exercised pinned CodeGraph indexing, queries and recovery, OpenWiki handoff and native planning resume, and daemon cleanup. Full wiki generation is a separate task. [Tool evidence](https://github.com/ansonli-dev/rigup/tree/main/docs/compatibility/evidence/2026-11-04-native-initialization) · [Final verification](https://github.com/ansonli-dev/rigup/tree/main/docs/compatibility/evidence/2026-11-05-open-source)
- **Project E2E.** Domain-Driven Hexagon passed its scoped setup. Bulletproof React completed the semantic lifecycle, apply, no-op update, and local edit protection with **10 requests / 855,212 tokens** from its original **12 / 1,200,000** budget. Its build, 21 unit tests and three Chromium flows passed. The model run used `73442ea` and read policy 5. Policy 6 reproduced the delivered evidence in a separate equivalence audit. [Project runs](https://github.com/ansonli-dev/rigup/tree/main/docs/compatibility/evidence/2026-11-05-github-projects) · [Final E2E and usage receipts](https://github.com/ansonli-dev/rigup/tree/main/docs/compatibility/evidence/2026-11-05-open-source)
- **Delivery gate and GitLab.** One live Codex/OpenSpec scenario enforced the approval and artifact gate. A disposable GitLab 19.5.3 with Runner 19.5.2 verified include resolution, snapshot results, failure reports, wiki loop prevention, and the missing-model pending report. [Scoped validation evidence](https://github.com/ansonli-dev/rigup/tree/main/docs/compatibility/evidence/2026-11-05-open-source)

## Pending validation

- Claude returned 401 on a real model request after reporting login. Resume with a usable account on the target machine. OpenCode has scoped discovery/MCP evidence, while the isolated Oh My Pi probe needs a provider. The full host × SDD matrix requires separate native sessions and real gates.
- Validate Windows with native Node and NTFS, and WSL2 with Linux tools and its own login. Current downloadable targets are macOS and Linux. [Claude and Windows handoff](../guides/external-validation-handoff.md)
- Target GitLab execution needs its own project, runner, permissions and model-backed OpenWiki update. Customer deployment needs a real authorized adapter and rollback procedure. Human review of generated guidance is a separate acceptance step.

[Reproduce local checks](../guides/development.md) · [Pinned integration versions](upstream-lock.json)

# Downloadable binary releases

## Intent and authority

The user requests GitHub Releases with downloadable commands that work without cloning/building Rigup, and GitHub Packages only if useful. They authorize continued implementation, environment installation, verification, commits/pushes and this requested release publication without intermediate confirmation. Keep `rigup init` canonical; no `ini` alias. Reuse the current linked worktree.

## Chosen approach

Publish a v0.1.0 development-preview prerelease containing native portable archives for darwin-arm64, darwin-x64, linux-arm64 and linux-x64. Each archive contains a small compiled C `rigup` launcher, the official pinned Node.js 24.22.2 runtime/npm, the compiled production npm package/dependencies, templates, pinned recipes and licenses. The launcher resolves its own real location, preserves the caller's cwd/arguments/stdin/signals and execs the bundled Node; it makes that runtime available to CLI children. No alternate JavaScript engine or SEA evaluation bridge is introduced. Archives must remain complete when moved; a loose launcher is not a standalone distribution.

Alternatives considered: Bun/SEA single-file compilation would change resource and worker loading, self-spawn semantics, native SDK compatibility and installed-asset behavior. A source/npm-only release still requires local build/runtime preparation. The portable archive preserves the tested runtime and actually removes clone/build/system-Node prerequisites for the CLI. Installed MCP/hooks still need their documented Node runtime on the consuming host/CI; keeping assets independent of Rigup code does not bundle a hidden runtime into each consumer project.

GitHub Releases is the public download channel; include SHA256SUMS, a pinned-version POSIX installer, release manifest and the compiled npm tarball as an optional Node-user download. Do not publish an npm/GitHub Packages registry package: GitHub's npm registry requires authentication even for public packages and adds no benefit to anonymous binary downloads. Keep `private:true`.

## Behavior and limits

- Build each target natively on GitHub's corresponding Linux/macOS runner, using Node 24.22.2 and official source-pinned runtime archive hashes. Build the production dependency tree with `npm ci --omit=dev --ignore-scripts` from committed package-lock.json, not by re-resolving a tarball install. Preserve upstream licenses and only production dependencies. No project checkout, private fixtures, account credentials or model exchanges in artifacts.
- Native Windows is not a supported artifact until its existing POSIX process/permission/recovery protections pass on Windows. Document Linux/WSL2 as the Windows validation route without declaring WSL2's full native-client matrix passed. No knowingly broken Windows installer is shipped.
- A release must pass credential-free core checks, actual extracted-archive help/version/current-directory preview/apply/no-op/doctor, and installed asset execution without Rigup application files. Include a relocated path with spaces and no system Node/npm in the test PATH.
- Installer detects only supported OS/architecture, fetches versioned public assets and checksum over HTTPS, verifies before execution, extracts to private staging, refuses unsafe archive paths and unrelated existing commands, installs versioned directories and atomically updates its own command symlink. Retain old versions for rollback/recovery; absolute runtime/worker paths bind pending operations, so recover through the original installation before moving/removing it. Do not use sudo or silently edit shell startup files. Provide manual installation and explicit rollback/removal instructions.
- Native SDK smoke on the macOS portable build must actually install pinned CodeGraph/OpenWiki, initialize/query CodeGraph, preserve the separate OpenWiki handoff, and retain state on uncertainty. No model turns, no full wiki generation, no budget reset.
- Build-only workflow_dispatch must never publish. Publishing is tag-gated, version-bound and requires every build/smoke job. Aggregate/verify artifacts, create a draft with contents:write only in the publisher, upload all complete assets and then publish the prerelease. Do not overwrite an existing tag/release or clobber immutable assets. No package write permissions.
- macOS launcher is ad-hoc signed where available; Developer ID/notarization requires an external account and must not be claimed. Linux minimum glibc/OS scope follows the actual native build/test environment and runtime requirements.

## Acceptance

Local RED/GREEN tests cover launcher argv/cwd/resources, checksum failure preserving existing commands, installer ownership/version/path validation and publisher manifest completeness/version binding. Native portable smoke passes locally and on all four build runners. Download the published asset anonymously, check its release checksum, extract in a new directory and run the command. Final main CI and tag release workflow must be green; documentation points to the actual downloadable release, not a future placeholder.

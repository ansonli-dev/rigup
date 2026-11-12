# Rigup 0.5.0 validation

The candidate combines fixes for issues #45 through #54. The native runs used Codex 0.166.0, OpenCode 1.18.5, Oh My Pi 18.19.0 and OpenSpec 1.16.0. The model was `gpt-6.1-sol` through each client's native provider binding.

The [evidence index](evidence/2026-11-12-open-issues/index.json) records the snapshot identity, test counts, versions and measured usage where available. Public evidence uses allowlisted fields. Raw model transcripts remain private. The temporary authentication profiles were removed after testing.

## Native OpenSpec workflow

Codex, OpenCode and Oh My Pi each passed real readiness and delivery checks on macOS ARM64, Linux ARM64 and native Windows 11 ARM64. Each host completed a separate four-phase macOS run that created the native artifacts, identified missing approval, revised the artifacts after developer feedback and reported readiness after explicit approval. The nine host and OS combinations cover selected cases. The macOS Codex delivery originally failed an evidence-parser assertion. Replaying its unchanged native records and pushed commits with the corrected parser verified the actual failing and passing tests and the scope of all pushes without an additional model call.

The positive delivery checks used real local Git pushes and a disposable loopback MR fixture. Acceptance required reading the finding before editing, observing the regression fail and pass, checking the approved scope of every outgoing range, and confirming required checks, configured review and the finding disposition for the current head. Codex's native `/goal` observations additionally checked the goal identity and persisted state. OpenCode and Oh My Pi used the compatibility entry.

Ordinary blocked cases covered missing design, missing approval, missing verification, an incorrect change reference, an unverifiable GOAL and pending, failing or stale MR results. Explicit bypass prompts exercised the host's instruction handling with and without the installed skill. The host's sandbox controls writes.

The OpenCode delivery observations count cached input on every generation. The later runs used a 1,200,000 observed-token ceiling and a four-minute wall ceiling on macOS and Linux. The Windows VM run used a six-minute ceiling. The artifact-writing preparation phases use the same OpenCode token ceiling. Windows Codex delivery used a 1,200,000 observed-token ceiling after a 600,000-token run reached its limit and failed pre-push review. Earlier attempts retain their original limits and verdicts. Oh My Pi delivery used a 16 MB bounded output buffer in the Windows retry after repeated streaming snapshots overflowed the initial buffer.

[Native workflow evidence](evidence/2026-11-12-open-issues/native-workflows.json) includes the completed phases, the historical attempts and their verdicts.

## Platforms and filesystem

Node 22.19 and Node 24 on macOS, Linux and Windows, plus the WSL2 job, passed on the [combined candidate](https://github.com/ansonli-dev/rigup/actions/runs/43251313192). A prior candidate passed six jobs while the WSL2 runner was cancelled. [Combined check evidence](evidence/2026-11-12-open-issues/combined-checks.json)

The [actual WSL2 filesystem run](https://github.com/ansonli-dev/rigup/actions/runs/43216562097) passed seven cases on ext4 and drvfs with and without metadata. It verified POSIX modes and private `0600` files, failure before project mutation when drvfs could not enforce permissions, and recovery of the same interrupted apply after restoring metadata. Fixture cleanup passed. [Mount and case evidence](evidence/2026-11-12-open-issues/wsl2-checks.json)

The [cross-platform complete checks](evidence/2026-11-12-open-issues/cross-platform-checks.json) retain the earlier shared snapshot and its platform-specific skips. [Runtime targeted checks](evidence/2026-11-12-open-issues/runtime-targeted-checks.json) cover protected dotenv handling, credential routing, provider accounting, Git safety and doctor. Windows additionally exercised actual NTFS ACLs, CRLF, long paths, launcher selection and rejected private file symlinks. Package checks exercised preview, independent apply, no-op update and stdio MCP from a nested Unicode path.

## Native tools and GitLab Runner

All nine host and operating-system combinations passed actual native discovery and MCP probes. CodeGraph indexing and interrupted-operation recovery ran on all three operating systems, and each fixture verified daemon cleanup. OpenWiki reached native planning and resume on all three operating systems. Full wiki generation was outside these runs.

Local GitLab Runner 19.5.2 executed four pipelines each on macOS ARM64 and Windows ARM64 against disposable GitLab 19.5.3. The cases exercised successful and intentionally failed JUnit checks, generated OpenWiki job skipping and rejection of missing runtime inputs. Both test projects were deleted. [Native tool and runner evidence](evidence/2026-11-12-open-issues/native-tools.json)

The separate authenticated Claude Code check remains assigned to the user's other Windows machine. [Claude handoff](../guides/external-validation-handoff.md)

# Project context for delivery

Use the native workflow to locate the approved change, task status and prerequisites. For OpenSpec, follow its apply instructions. Confirm any omitted planning artifact is explicitly optional and use the native recovery step for a blocked state.

Read the applicable rules and commands under **Existing checks**. A hook counts as evidence after it runs on the intended input. Confirm service setup and environment variable names from the linked sources.

After approval, run each task's project command in its recorded working directory. For behavior changes, use the approved scenarios as the test expectations. Use native command output to locate a failure, repair within scope, then rerun the same check. Record the command, result and any project test report or CI job link in the native task. Keep a task open until its verification passes.

If access is blocked, hand off the exact project command and its working directory with the missing prerequisite. Use the project's own test reporter or CI artifacts when available. Read that result on resumption, or use a sanitized exit status and test summary from the authorized terminal. Keep environment values private.

## Installed workflow

Native prepare: openspec-propose
Native revise: openspec-update-change
Native deliver: openspec-apply-change, openspec-archive-change
Native document routes: openspec/specs, openspec/changes
Retain native artifact dependency checks and archive decisions
Use existing project checks before marking implementation complete
- [.agents/skills/openspec-propose/SKILL.md](../../openspec-propose/SKILL.md)
- [.agents/skills/openspec-apply-change/SKILL.md](../../openspec-apply-change/SKILL.md)
- [.agents/skills/openspec-archive-change/SKILL.md](../../openspec-archive-change/SKILL.md)
- [.agents/skills/openspec-update-change/SKILL.md](../../openspec-update-change/SKILL.md)
- [.agents/skills/openspec-sync-specs/SKILL.md](../../openspec-sync-specs/SKILL.md)

## Project guidance

- [README.md](../../../../README.md) · .

## Existing checks

Working directories are relative to the repository root.
- `npm run build` from `.` · [package.json](../../../../package.json)

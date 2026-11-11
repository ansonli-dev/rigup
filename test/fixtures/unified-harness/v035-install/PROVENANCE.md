# Rigup 0.3.5 installed fixture

This fixture was generated using `node dist/cli.js` built from tag `v0.3.5` at `be0ca645f9c99c6890adedb9bc7141e3ea720ab2`. The fixture contains the completed manifest and exactly the baselines it references. An earlier, unreferenced foundation baseline directory was omitted.

Inputs are the original README, customer AGENTS text and GitLab job, the npm build script, and the settings in `.rigup/config.yaml`. OpenSpec 1.16.0 initialized the Codex workflow with `openspec init --tools codex --profile core --no-animation --no-copilot-cloud <root>`.

1. Run `rigup init <root> --agents codex --sdd openspec --tools none --defer-research --review --json` with the old binary.
2. Apply the returned preview with `rigup update <root> --apply <id> --sessions-ended --json`.
3. Start the old `rigup mcp <root> --host codex`. Submit a reusable project build guidance binding citing line 2 of README.md with root scope, no observations and no additional artifacts. Finish to obtain the approved ready preview.
4. Apply that preview with the old binary.

The live upgrade test regenerates the same installation classes from the old binary in disposable directories. It generates path-bound approvals and recovery records on the machine running the test.

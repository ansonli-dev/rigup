# Rigup harness evaluation v3

The default plan schedules T4 through T6, four arms, and three repeats for 36
cells. A starts from the fixture alone. R adds Rigup project rules. S adds
Rigup’s workflow and the native OpenSpec entries. B uses both. T1 through T3
and T7 can be selected separately. Rigup setup, rule generation, and the
authentication probe take place outside measured task sessions.

## Plan and test offline

```sh
node test/harness-e2e/run.mjs --plan
node test/harness-e2e/run.mjs --plan --tasks T1,T2,T3,T7 --arms A,R --repeat 1
node --test test/harness-e2e/fixture.test.mjs test/harness-e2e/runner.test.mjs
```

The plan uses the fixed hidden denominator for each checkpoint. The runner
tests use a local stub executable and synthetic treatment assets.

## Prepare the treatment assets

Create a separate disposable seed for each task you want to prepare. Start
each setup from the same task baseline.

```sh
node --input-type=module -e 'import {writeFixture} from "./test/harness-e2e/fixture.mjs"; await writeFixture(process.argv[1], process.argv[2])' "$SEED" T4
```

Use the installed Rigup’s normal review and apply workflow in the seed.
For OpenSpec, use the locked native preparation before review.

```sh
rigup init "$SEED" --agents claude --sdd openspec --prepare-openspec --json
```

Set `projectRules: false` in the selected Rigup profile for S. Generate and
apply the rules separately for R and B with `projectRules: true` and the
configured Rigup research backend. Use the same accepted rule files for R
and B, and the same native OpenSpec files for S and B. Review rule content
before freezing the assets. Record actual versions and known generation cost
in each condition’s metadata.

The prepared directory has one folder per task ID. Each R, S, or B overlay
contains its installed portable files at repository-relative paths. The
sibling JSON contains metadata that stays outside the model workspace.

```text
prepared/
  T4/
    R/
      CLAUDE.md
      docs/rigup/development-rules.md
    R.json
    S/
      CLAUDE.md
      .claude/skills/change-prepare/SKILL.md
      .claude/skills/change-deliver/SKILL.md
      .claude/skills/openspec-propose/SKILL.md
      .claude/skills/openspec-apply-change/SKILL.md
      .claude/skills/openspec-archive-change/SKILL.md
      openspec/config.yaml
    S.json
    B/
      ...
    B.json
```

R and B require a link to `docs/rigup/development-rules.md` from
`CLAUDE.md`. If the rules-only install emits the rule index without an
entry file, add a short link in the R overlay and record that assembly step
with the generation evidence. Include installed skill references and rule
topic pages in their original paths. Leave the fixture source and tests in
the seed. The runner copies only treatment files and rejects settings files,
links, credentials, native install caches, and prewritten OpenSpec changes.

```json
{
  "rigupVersion": "0.2.5",
  "sddRoute": "openspec",
  "nativeVersion": "1.16.0",
  "generationCostUsd": null
}
```

Use `null` for the SDD route and native version in R, and `null` for an
unknown generation cost. The optional `rigupCommit` is a full Git SHA.
The runner loads and hashes selected overlays before opening task sessions.
It checks equal native files and declared native versions when both S and B
are selected, and equal rule files when both R and B are selected. Keep the
same recorded digests across separate runs. A needs no overlay.

`--sdd-route` selects the same route for S and B in a batch. The pilot
defaults to OpenSpec. Spec Kit and Superpowers require corresponding
project-local native entries in the overlays. Plugin-dependent or
machine-local installations need a separate evaluation. For OpenSpec put
the corresponding installed launcher on PATH or pass `--sdd-bin` with its
absolute path. The reported native version is the prepared version from
the metadata.

## Run with Claude Code

Use Node.js 24 and Git. On native Windows start the Node commands with
`node --import tsx` so the runner can load Rigup’s ACL verifier. Use a
private output parent on a filesystem with the required ACLs.

Install the current Claude Code release in the evaluation environment
before the run. The runner requires Claude Code 2.1.259 or newer, probes
its version, records the executable hash, and checks that it stays fixed.
Pass `--claude` an absolute path to the selected installation. With no
path, the runner searches PATH for `claude` or `claude.exe`.

The default mode uses a fresh home and authentication from one of
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN`.
An existing Claude login is opt-in with `--use-existing-login`. It uses
the host login location with restricted mode, project-only setting
selection, an empty plugin cache, disabled auto memory and hooks, and an
empty explicit MCP configuration. The client can still enforce managed
policy. Startup evidence distinguishes bundled plugins from external
plugins. The runner rejects external plugins and unrelated MCP servers.
Every session disables on-disk Claude transcript persistence.

Run the explicit tool-free probe first. It reports authentication and cost
separately from the matrix. A revoked login appears as
`status: "unsupported"` with `reason: "authentication-revoked"`.

```sh
node test/harness-e2e/run.mjs --preflight \
  --claude "$CLAUDE" --expect-claude-version "$CLAUDE_VERSION" \
  --model "$CLAUDE_MODEL" --out "$EVAL_OUT"

node test/harness-e2e/run.mjs --run \
  --claude "$CLAUDE" --expect-claude-version "$CLAUDE_VERSION" \
  --model "$CLAUDE_MODEL" --out "$EVAL_OUT" \
  --prepared-dir "$PREPARED" --sdd-bin "$OPENSPEC"
```

For one bare pilot cell, add `--tasks T4 --arms A --repeat 1` and omit
`--prepared-dir` and `--sdd-bin`. Use a fixed model ID throughout the
batch. The default timeout is three minutes per distinct session and can
be adjusted with `--timeout-ms`.

## Interpret the evidence

Each cell uses a fresh Git fixture. T5 makes three distinct Claude sessions
in the same checkout and scores the first and final checkpoints. T6 makes
one session. The runner sends at most one canonical answer on the same
stream after an explicit relevant question, unchanged implementation
digest, and an event trace without implementation edits. The automated
matcher is conservative. It reports clarification independently of the
hidden score.

The safe `summary.json` contains cell statuses, checkpoint scores and
failing IDs, visible suite status, and the CLI’s reported usage and elapsed
time. Task cost sums the last cumulative estimate for each distinct
session. The individual result records remain available for partial
sessions and missing estimates. Generation and preflight estimates are
separate. Report the CLI estimates separately from billed amounts.

Redacted model streams, stderr, and scorer diagnostics are in the private
output subdirectory. The runner does not record environment values.
Treat even redacted raw streams as private. The hidden judge runs on an
independent scratch copy. The runner deletes working directories after
evaluation and retains them if it cannot verify process-tree cleanup.

Exit code 0 means every selected cell passed, or the preflight passed.
Exit code 1 means a completed validation failed. Exit code 2 means a
timeout, unsupported setup, or infrastructure failure. Interrupting the
runner returns 130 after process cleanup. Use the individual status fields
to distinguish these outcomes.

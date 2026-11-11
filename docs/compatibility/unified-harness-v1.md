# Unified Harness V1 verification

Rigup 0.4.0 uses the same preview and protected apply sequence for new services, mature services and mixed repositories. The repository fixtures exercise scoped npm and GitLab discovery, authority reuse, one-time convention pages, confirmation, and unchanged updates. The mixed fixture also exercises a module-only update, stale source approval rejection, retained global GitLab wiring and separate legacy and new-module rules.

## Reproduce the release gate

Run `npm run check` from the Rigup checkout. Build the old CLI from `v0.3.5` at `be0ca645f9c99c6890adedb9bc7141e3ea720ab2` in a separate directory, using the tag's lockfile. Build the candidate with `npm run build`. Put OpenSpec 1.16.0 and Codex on PATH for native workflow verification. You can also set `RIGUP_HARNESS_OPENSPEC_BIN` to the pinned OpenSpec launcher.

```sh
RIGUP_V035_BIN=/path/to/v035/dist/cli.js \
  RIGUP_LIVE_EVIDENCE_DIR=/path/to/evidence \
  npm run test:live -- --test-name-pattern='harness upgrade'
```

The live gate uses disposable repositories and private state directories. It fails when the old executable is unavailable or reports a different version. The offline fixture at `test/fixtures/unified-harness/v035-install` keeps the old manifest and its referenced baselines.

## Observed upgrade behavior

- The old CLI created and applied legacy provider, modern pending and modern ready installations. The legacy case installed and initialized CodeGraph. The ready case used explicit GitLab checks, OpenSpec and a generated project rules index. A normal 0.4.0 review and apply preserved the selections, tool receipts, customer configuration, original GitLab bytes and baseline contents outside the new convention navigation. The merge also preserved a local edit in the managed preparation reference.
- The new CLI rejected the unapplied old approval. A fresh preview applied successfully.
- The old CLI was stopped during an approved npm build after project writes and before manifest commit. The new CLI preserved the durable journal and refused both the original approval and a replacement. The old CLI resumed, completed its build check, and committed the installation. A subsequent new preview upgraded it.
- Codex 0.166.0 discovered the installed prepare and deliver skills with OpenSpec 1.16.0. Both skill references resolved to the customer guide, the confirmed convention page and their expected native workflow entry. The probe used native discovery without starting a model turn.
- GitLab evidence covers static job discovery and preservation of selected wiring. Runner execution requires the target GitLab project and runner.

The live upgrade gate ran on macOS ARM64 with Node 24.15.0. The platform regression command passed 59 tests on Linux ARM64 with Node 24.22.2 and 59 tests on Windows 11 ARM64 with Node 24.22.1.

```sh
node --import tsx --test test/ownership-path.test.ts test/installer.test.ts test/recovery.test.ts
```

To return to v0.3.5, restore the pre-upgrade project configuration and installation snapshot before replacing the binary. The old CLI cannot read the new topic settings.

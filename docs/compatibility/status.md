# Current validation status

Rigup 0.1.0 is a source-distributed development preview. Read this page before interpreting the [historical ledger](https://github.com/ansonli-dev/rigup/blob/main/docs/compatibility/verification.md): early pending entries there can be superseded by later source-bound evidence.

## Verified scope

- The local suite covers CLI/configuration, evidence and budget handling, staged context, generation, protected three-way updates, preview binding, ownership, interrupted operation recovery, standalone hooks/MCP, and package independence. The last pre-readiness baseline is **320 passed, 14 opt-in live skipped, 0 failed** on macOS/Node 24.15.0; current checks are recorded with the readiness evidence below.
- Actual Codex 0.166.0 native discovery and customer MCP, packaged assets after removing Rigup, pinned tool loading, and protected CodeGraph initialization/recovery have real-client evidence. OpenWiki installation/MCP and its independent initialization handoff are in scope; full wiki generation is a separate user task.
- Real GitHub E2E projects include [domain-driven-hexagon](https://github.com/Sairyss/domain-driven-hexagon) and [Bulletproof React](https://github.com/alan2207/bulletproof-react). The latter completed analysis, plan, content, acceptance, independent apply, no-op update and user-change protection within the original **12 requests / 1,200,000 tokens** budget: **6 observed requests / 499,754 tokens**, including review follow-up. Sources, application tests and limitations are in the [stage-context evidence](https://github.com/ansonli-dev/rigup/tree/main/docs/compatibility/evidence/2026-11-05-stage-context).
- One real Codex/OpenSpec delivery-gate scenario consumed project references and refused implementation without approval/native artifacts. This is a bounded scenario, not proof of all native gates or all host/SDD combinations.

See [readiness evidence](https://github.com/ansonli-dev/rigup/tree/main/docs/compatibility/evidence/2026-11-05-open-source) for the final source/distribution checks and local integrations. Evidence states its tested source and does not silently transfer model-quality approval to later code.

## External conditions and resume steps

- **Other model providers and native hosts:** Claude Code model requests previously returned 401 despite reported login; Oh My Pi lacked a usable model in the isolated fixture. The user will continue Claude on another machine. Configure a working account/provider on that machine, then run the relevant named probes in `test/live-compatibility.test.ts` with `RIGUP_LIVE=1` and a new `RIGUP_LIVE_EVIDENCE_DIR`. Do not copy credentials into test fixtures. OpenCode discovery/MCP has bounded evidence; its real model/gate matrix still needs a usable selected provider.
- **Complete four-host × three-SDD matrix:** configuration adapters and contract tests are implemented; full real sessions for every prepare/deliver/review gate are not claimed. After providing the native client, official pinned SDD entry points, and model access, run one scenario at a time and retain actual artifact/gate evidence. Start with the Codex/OpenSpec named gate probe described in the [development guide](../guides/development.md).
- **GitLab runner and OpenWiki CI:** real target-project CI lint, runner permissions, protected branch rules, and model-backed wiki update require a GitLab project/runner and provider authorization. Local snapshot/anti-loop tests are available in `test/gitlab.test.ts`. The readiness evidence records any additional local server validation; it does not establish a remote project's authorization. Supply the target GitLab URL, project, scoped token, runner and model environment before validating that deployment.
- **Release/deployment workflow:** no real deployment adapter or authorized target is configured. Do not generate a pretend release capability. Supply the actual adapter, permitted target, verification and rollback procedure before testing change-release.
- **Windows/native platform matrix:** no Windows host is available locally. Linux/macOS credential-free checks are the CI targets; native host/tool compatibility must be tested on each platform before being claimed.
- **Human semantic approval:** existing source audits and model acceptance are evidence, not a user's formal approval of generated project guidance. Review the concrete preview in the target project before installation.

These are validation prerequisites and product boundaries, not hidden passed checks. OpenWiki long initialization is intentionally separate from scaffold completion. Provider-side hard token ceilings are not available through the default CLI adapter; cumulative observed usage and unknown-charge blocking remain enforced locally.

## Reproduce

Run `npm ci && npm run check` from the source checkout. See the [development guide](../guides/development.md) for opt-in real integrations and the [usage guide](../guides/usage.md) for configuration, preview/apply, recovery and exit codes. No external credentials are required for the default check.

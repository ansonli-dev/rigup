# Execution decisions

Plan: docs/superpowers/plans/2026-11-05-open-source-readiness.md. These are all decisions made on the user's behalf, in order; each includes the cost if wrong.

Ruling: Use MIT for the new source distribution and retain private:true for npm — the user requests an open source project and GitHub push, not a registry release — if the license choice is wrong it must be changed before a later release; no package will be published by this task.

Ruling: Include coherent existing Rigup document renames and associated design updates after content/link review — public users need the same reachable authority used by the implementation; no user content is discarded — if mistaken this exposes unfinished design prose, so docs label design/history separately from current behavior.

Ruling: Package-consumer checks prefer cache but may fetch public registry metadata — clean npm ci caches tarballs without all packuments, so --offline made a fresh checkout fail; dependency install scripts remain disabled and model tests remain opt-in — if wrong, offline users need to warm metadata or defer the package smoke; docs state the network prerequisite.

Final: Ruling: Full host/SDD/provider behavior stays scenario-bounded — unavailable authenticated providers and actual native sessions are required; no full matrix claim ships — if wrong, users may need additional integration fixes after provisioning.

Final: Ruling: Model acceptance remains distinct from human semantic approval — existing source-bound E2E is evidence, not a human signature — if wrong, generated guidance still needs the user's review.

Final: Ruling: Full OpenWiki generation and remote GitLab model updates remain separate — no authorized remote project/provider credential is supplied, and scaffold scope explicitly excludes long wiki generation — if wrong, remote provisioning/integration work remains after credentials are supplied.

Final: Ruling: Windows and untested native platforms remain explicitly unverified — no Windows host or equivalent native environment is available — if wrong, platform-specific fixes may be required later.

Final: Ruling: Do not invent a release adapter — no actual deployment adapter, target or authorization is configured — if wrong, release integration must be implemented when a real target exists.

Final: Ruling: Same-OS-user tampering is outside the CLI isolation guarantee — implemented path/receipt checks remain reviewed, but a privileged peer can alter code/state after checks — if wrong, a stronger OS execution boundary is required; docs must not imply one.

Final: Ruling: Explicit file modes follow baseline/local/new ownership — upstream-only mode changes apply; user-only chmod is preserved and diagnosed, divergent concurrent mode changes conflict, and every preview/recovery binds actual modes — if wrong, an executable remains pending user reconciliation rather than silently overriding permissions.

Final: Ruling: Interpret short flags in their command context — Python interpreter options are not credentials, curl short user/cookie arguments are credentials, common long/header/URL forms remain protected — if wrong, uncommon client wrappers require an explicit adapter or declared environment references; arbitrary custom flag semantics cannot be inferred universally.

All six findings in the one fresh review and the subsequent verification findings were fixed. No deferred minor remains. No second review was commissioned. The user explicitly authorized continuous work, commit and push.

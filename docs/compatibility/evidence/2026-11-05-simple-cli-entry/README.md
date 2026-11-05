# Project-root CLI verification — 2026-11-05

The canonical commands are `rigup` and `rigup init`. The user clarified that `ini` was a typo; no alias is implemented. The candidate is bound by exact source/build hashes in [terminal evidence](terminal.json), with a read-only [review and fixed findings](review.json).

Four actual macOS ARM64 terminal sessions passed after `npm link` registered the source CLI in an isolated npm prefix: project-root init, bare project menu, all choices supplied, and a partial backend argument. Each case used the installed `rigup` command through PATH, resolved its current directory, selected no SDD/tools, and stopped at a dry-run preview with the project untouched. This is real terminal/registration evidence, without a paid model or SDD compatibility claim. The user's global npm prefix was not changed.

The final check passed 347 tests, with 15 opt-in live skips and zero failures; type checking, build, doc links and the independent 80-file package passed. The package smoke now also resolves `rigup` through PATH and omits the target path for preview/apply/update/doctor. Both review findings were reproduced before fixes. Eight retained new regressions cover partial options, preservation, Back and hidden-key cancellation. The temporary alias regression was removed with the alias.

The [exact terminal harness](pty-harness.py.txt) is archived for reproduction from the repository root after `npm ci && npm run build`: `python3 docs/compatibility/evidence/2026-11-05-simple-cli-entry/pty-harness.py.txt`. It uses Python's POSIX PTY and a macOS `/private/tmp` evidence path; it is not a Windows test. Temporary npm links/projects are removed on success, raw transcripts stay in that private evidence directory, and their hashes are in the report.

Native Windows/WSL2, actual Claude/provider sessions, long OpenWiki generation and remote targets retain the conditions in the [handoff checklist](../../../guides/external-validation-handoff.md). No previous model ledger was reset, copied or charged by this run.

The first [push CI](https://github.com/ansonli-dev/rigup/actions/runs/41964726532) passed the runtime tests on both runners but caught a final docs-index link pointing to source-only evidence omitted from the package. That index now uses a repository URL; the source link check and isolated package/PATH lifecycle passed again. This failure and the corrected package integrity are preserved in the review record.

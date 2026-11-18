# Setup and doctor output design · Issue #85

[Issue #85](https://github.com/ansonli-dev/rigup/issues/85) tracks the six linked fixes and the remaining P1/P2 work. This design covers its unassigned checklist items. The linked designs cover the native, localization, lifecycle, environment, and clone behaviors.

## Verified behavior

On main `51406c2`, an isolated Chinese two-agent review printed the full preview ID in its heading, five paths, and an absolute private log path. The apply command repeated the ID. An initialized project with pending rules and two hosts printed ten doctor diagnostics. Seven were routine, and the output lacked a summary or a separate action. In the Chinese locale, selecting English in the wizard left the heading and detection line in Chinese.

`--agent codex` returned 2 with a generic unknown-option message. `--sdd foo` also returned 2, but printed an install result and an English validation message. The OpenSpec fixture writes six native files. The existing publishing loop knows every written target, and the CLI reports readiness and managed Rigup target counts separately.

## Terminal behavior

- A normal project preview shows actual changed files grouped as agent configuration, project guidance, Rigup support files, or other project files. Each nonempty group gives create, update, and delete counts. The decision-time package operation, version, destination and integrity remain visible. A copyable saved-preview apply command contains the complete ID. `--verbose` shows the full ID, private log path when available, exact paths, and safe detail text. If the private detail log is unavailable, show every changed path in the preview so the user can still check the scope.
- Once OpenSpec publishes native files, report the number written and their approved project scopes. `--verbose` also shows actual file paths. No-write reruns omit this line. This report is separate from Rigup's apply count.
- `doctor` starts with a count of passing or ready diagnostics and ones requiring attention. It shows failed, pending, and reload-required rows first, followed by explicitly requested check results and the most urgent next step. Use a report-provided recovery or initialization command first. Without one, prioritize failed diagnostics, then pending rules, then pending environment inputs, then session reload and other pending items. `--verbose` includes all rows. Machine reports preserve existing fields, exit codes, and their original English fallback error.
- A mistyped `--agent` suggests `--agents`. Unsupported `--sdd` lists `superpowers, openspec, spec-kit, none` before any setup result. Existing English machine errors stay stable even with a saved Chinese locale.
- After the language selection, show the wizard header, detection progress, and later prompts in the chosen locale. The language prompt remains first and bilingual. Preserve the existing order of choices. Render localized names for reached phases, then summarize their sequence at the end of a multi-phase run. Include OpenSpec preparation when executed. Skipped phases are absent.

## Verification

Exercise both terminal languages, redirected output, the existing preview decision, saved-ID reuse, doctor and JSON fallback with an actual manifest, and OpenSpec preparation through the existing fake native CLI. Apply remains protected by the same reviewed file, package, and recovery contracts.

The updated tracker calls for reviewable, sanitized complete output for common init, update and doctor runs. Compare these transcripts after replacing the temporary root and opaque preview ID. Use a stable locale, an isolated working directory and a controlled agent executable. Review snapshot changes as user-facing copy.

The linked tests cover the missing and already installed Superpowers cases, a forced no-symlink-permission installation and real Windows probe, explicit synthetic credentials, the 25 Chinese error cases, the saved preview exit and wording, and an actual repository clone. Extend the existing genuine native-host CI artifact to document whether the current process can create a directory symlink in a clean temporary directory, and verify the matching OMP path and package receipt. Record the observed Windows permission and avoid inferring it from the runner image name.

# Project context for delivery

Use the installed native workflow to locate the exact change and its approval, task status and prerequisites before applying it.

For OpenSpec, use the state in its native apply instructions. When it reports ready with an omitted planning artifact, confirm the artifact instructions explicitly allow that omission and proceed within the approved scope. A blocked state needs its native recovery step.

Read the source for each applicable rule and the commands in the nearest project manifest. Check hook configuration for its actual entry and trigger. A configured hook counts as verification once it has run for the intended input. Record manually run checks separately.

For a specialized check, open its linked manifest and the test configuration or runbook it uses. Confirm any required local services, setup commands, readiness checks and environment variable names from those sources. Use the documented local setup and approved environment, wait for readiness, and stop the services you started after checking. Record environment variable names or configuration references and keep their values private.

If a sandbox restriction or missing prerequisite prevents verification, use the terminal command in the check entry when present. Hand off one copyable command with its working directory and any test arguments, the observed error, and the affected workflow task identifiers. Ask for the exit status and relevant test summary with secret values removed. Leave those tasks open until the returned evidence covers them. Resume verification for the affected tasks when the evidence arrives.

Keep failed and unrun checks visible when handing off. A successful check provides evidence for the scope it exercised.

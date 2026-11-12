# Project context for delivery

Use the native workflow to locate the approved change, its GOAL, task status and prerequisites. Read all current Spec and Plan references in that GOAL, including split artifacts, and use the same scope for both `/goal` and compatibility delivery. For OpenSpec, follow its status and apply instructions; a missing native prerequisite cannot be made optional by the preparation agent. Use the native recovery step for a blocked state.

Read the applicable rules and commands under **Existing checks**. A hook counts as evidence after it runs on the intended input. Confirm service setup and environment variable names from the linked sources.

When **Team conventions** is present, verify the change against the confirmed pages whose scopes cover the touched paths.

After approval, run each task's project command in its recorded working directory. For behavior changes, use the approved scenarios as the test expectations. Use native command output to locate a failure, repair within scope, then rerun the same check. Record the command, result and any project test report or CI job link in the native task. Keep a task open until its verification passes.

If access is blocked, hand off the exact project command and its working directory with the missing prerequisite. Use the project's own test reporter or CI artifacts when available. Read that result on resumption, or use a sanitized exit status and test summary from the authorized terminal. Keep environment values private.

When GOAL includes pushes, review the outgoing commits before every push. When it includes an MR, use only project-configured tools and existing required CI/reviewer signals for the latest head SHA. Preserve finding dispositions and verify the head again before handing off completion; a later push invalidates older completion evidence.

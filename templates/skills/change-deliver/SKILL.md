---
name: change-deliver
description: Implement, verify, or review a concrete project change using the approved native change artifacts and the project's existing checks. Use after planning and any required approval.
---

# Deliver a change

1. Open [project context](references/project.md). Inspect the selected change and the installed delivery entry. Check the approved scope, prerequisites, authorization and remaining budget. With a customer-only workflow, use the listed delivery skill and its approvals. Stop when the native workflow blocks delivery or a required human approval is missing.
2. Read the original guidance and project development rules that apply to the files you will change. Before editing a request type, validator, or reusable helper, search its references and verify that consumers outside the approved scope keep their behavior. If the approved approach would change those consumers, return the affected task for revision and approval before editing. Follow the nearest implementation and reuse or extend its existing test. Use the current hooks and CI checks. When they leave a gap, describe the missing check and where it belongs so it can be reviewed separately.
3. For implementation, follow the authorized apply steps. For review, inspect the current diff and check evidence. For behavior work, check the approved cases and exercise the requested behavior and the preservation case. When possible, observe the new regression test fail for the expected reason before the implementation or in a disposable baseline. On the delivered change, rerun the behavior check and run the applicable project commands from the task, including lint and type checks. Record each command and result. Address a failing condition within the task and budget, with at most two repair attempts for that condition.
4. Update task status for verified work. Follow the workflow's verification and closure steps when their prerequisites and authorization are satisfied. Hand off the change identifier, diff, check results, and any unrun checks or blockers. For an unresolved failure include the evidence, attempted fixes and next owner.

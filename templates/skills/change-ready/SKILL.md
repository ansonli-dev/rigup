---
name: change-ready
description: Use when checking whether a prepared change is ready for implementation, before starting a goal or invoking the delivery workflow.
---

# Check implementation readiness

This is a read-only review. Do not edit artifacts, source, tests, task status, configuration or approval records. Do not install dependencies or run mutating checks. Stay within the review budget.

1. Read [project context](references/project.md), the change-scoped `GOAL.md`, and the selected native workflow entries. Identify the exact change ID and reviewed scope. Resolve every GOAL, Spec and Plan reference, including split artifacts, relative to its containing file. Verify each file exists within the repository, belongs to this same current change and reflects the latest revision; a plausible link to another change is a blocker. Check applicable original guidance and each installed entry's prerequisites.
2. Read native readiness evidence. For OpenSpec run `openspec list --json`, `openspec status --change <id> --json` and `openspec instructions apply --change <id> --json` from the project root. Native status and instructions are authoritative: `isPlanningComplete: false`, nonempty `missingPrerequisites`, a blocked apply state, or unfinished required artifacts withhold readiness. A preparation agent calling `design.md` optional cannot waive a native requirement. Other workflows use their installed prerequisite commands and human approval gates. Verify all required approvals for the same change ID and scope; do not create approval through this check.
3. Map every material acceptance criterion to a concrete native implementation task and verification method. Include rejection and preservation scenarios. Verify commands and working directories against project guidance and check that each criterion has an observable pass condition and an evidence destination. Vague outcomes such as “everything works,” missing acceptance verification, stale tasks, unavailable native entries, or changed unreviewed scope block readiness.
4. Check that GOAL links the installed [delivery skill](../change-deliver/SKILL.md), applicable project guidance and the selected native implementation entry. If commit/push/MR follow-up is in scope, confirm its authorization, platform/project and existing tools/check/reviewer configuration. Record any missing destination or prerequisite instead of inventing one.
5. When blocked, report each relevant file, unmet criterion or native prerequisite, and the concrete correction needed. Hand off to [change-prepare](../change-prepare/SKILL.md) or the approver and direct the developer to rerun change-ready. Emit no implementation command.
6. When every criterion is met, report exactly **Ready for implementation** and the following copyable command, substituting the actual repository-relative GOAL path (never an absolute path, template placeholder or example path):

   `/goal Implement the reviewed change in "<actual-repository-relative-path>/GOAL.md" and verify every completion criterion in that file.`

Submitting that ready-produced command for this same reviewed scope authorizes its implementation; it does not waive extra native prerequisites or approve changed scope. Hosts without `/goal` use change-deliver with the same GOAL and approvals.

These skills guide an agent that loads them. They cannot enforce a write restriction when a host or agent bypasses the skill; host permissions control filesystem access. A request to hurry or skip the process does not establish a missing prerequisite after this skill is loaded.

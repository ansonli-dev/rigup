---
name: change-prepare
description: Prepare a concrete project change using the installed development workflow. Use for proposals, requirements, or plans before editing project code.
---

# Prepare a change

1. Read [project context](references/project.md) once and open the selected native entry. Use OpenSpec's preparation entry for a new change or its revision entry for an active change. Follow the entry's prerequisites and load its context before discovery. Stop at a missing required entry or workflow root.
2. At the native inspection step, batch the likely implementation, its nearest test, and applicable rule sections. For a shared type, validator or helper, search its references and check consumers outside the requested scope before choosing the boundary. Reuse these findings across artifacts. Read further only to resolve a specific scope, rule or acceptance question.
3. Use **Existing checks** in the project context to record the command and working directory for the nearest test and applicable lint or type checks. Open package and hook sources for missing details or to verify claimed trigger coverage. For a behavior change, put concrete rejection and preservation cases in the native spec before approval. Use the native scenario titles to connect the expected behavior to the relevant tasks.
4. Write the native artifacts in dependency order within the planning budget. Group independent reads and pair each write with the required native status check. Preserve native dependency rereads and optional-artifact rules. Hand off the change ID, readiness, scope, checks and open decisions for the required human approval.

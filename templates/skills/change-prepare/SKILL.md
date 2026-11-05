---
name: change-prepare
description: Prepare a concrete project change using the installed development workflow. Use for proposals, requirements, or plans before editing project code.
---

# Prepare a change

1. Open [project context](references/project.md). Inspect the installed workflow and check its prerequisites before writing. For OpenSpec, use the prepare entry for a new proposal and the revision entry for an active change. If the required entry or workflow root is unavailable, identify the missing prerequisite and stop at that step. With a customer-only workflow, use the listed preparation skill and its prerequisites.
2. Establish the outcome, affected paths, allowed operations, budget and acceptance criteria. Match project development rules to the paths. Read original guidance for its scope and exceptions. Inspect the nearest implementation, test and hook that cover the behavior. Carry conflicts that affect the change forward as decisions.
3. Follow the selected entry to write or revise its artifacts in dependency order. Record the expected behavior, implementation boundary, applicable rules and checks in the workflow's own artifacts. Name the test to extend or run and its working directory. Follow native human approval gates and the planning boundary.
4. Check native readiness and record any omission allowed by the artifact's instructions. Hand off the change identifier, artifact locations, scope, check commands, open decisions and next workflow action. Wait for the required approval or separate implementation request.

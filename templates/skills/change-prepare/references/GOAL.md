# Implement <change ID>: <observable outcome>

Fill this template in the native change directory. Replace every placeholder, use repository-relative paths in command text, and rewrite Markdown links relative to the new GOAL file. Link every current Spec and Plan artifact, including split files. Remove these instructions after filling it.

## Reviewed change

- Change ID and native workflow: <exact ID and selected workflow>.
- Outcome and approved scope: <observable behavior and allowed paths>; preserve <out-of-scope behavior>.
- Spec artifacts: <links to every current requirement/scenario file for this change>.
- Plan artifacts: <links to every current design, implementation and verification task file for this change>.
- Native implementation entry: <installed skill or command and its resolved path>.
- Native status/instructions and required approvals: <current evidence, exact scope and any remaining gate>.

## Delivery instructions

Read the [installed delivery skill](../../change-deliver/SKILL.md) and [project context](project.md), including applicable original guidance, before implementation. Follow the selected native implementation entry with these same reviewed artifacts. A developer submitting the ready-produced `/goal` for this same reviewed change authorizes implementation of this scope; extra native prerequisites and approvals still apply. Changed scope requires review again. On hosts without `/goal`, invoke change-deliver with this GOAL.

## Completion criteria and evidence

| Acceptance criterion | Native implementation task | Verification command/scenario and working directory | Observable pass condition and evidence destination |
| --- | --- | --- | --- |
| <material scenario, including rejection/preservation cases> | <task link/ID> | <existing check and cwd, or an explicit manual observation> | <expected result and where actual results will be recorded> |

Complete every row, run the required project checks, and record actual results. A claim without observable evidence is incomplete. Report unavailable checks and blockers instead of marking them passed.

## Commit, push and MR scope

- Authorized commit/push/MR actions: <explicit scope or not requested>.
- Before every push, review all outgoing commits against the approved scope, fix confirmed findings and rerun affected checks. Record the reviewed range and results before pushing.
- If MR follow-up is included: <confirmed platform, project, MR identity and configured customer command/MCP/CLI from project guidance>.
- Required CI checks and configured AI reviewer: <existing project configuration and how completion is observed; no new CI/reviewer configuration>.
- Completion evidence: latest MR head SHA, every required check passed for that SHA, explicit completed AI review when configured, and a recorded disposition for every finding. Re-read the head before declaring completion. Pending review with no discussions, failed checks, and green results for an older SHA are incomplete. Fix confirmed findings within scope locally, verify and review outgoing commits, push, then follow the new SHA again. Record evidence for disputed findings; return expanded scope for review.

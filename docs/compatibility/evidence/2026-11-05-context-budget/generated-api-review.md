# React Vite API hook review aid

For contributors and reviewers changing cache refresh selection or query configuration in React Vite API hooks. Continue to use the original [API declarations guidance](../api-layer.md); this supplement addresses only the refresh-selection and configuration gap it leaves open.

## Checked local examples

| Checked hook | Observed behavior | Review boundary |
| --- | --- | --- |
| [Discussion update](../../apps/react-vite/src/features/discussions/api/update-discussion.ts) | Its success handler calls `queryClient.refetchQueries` with the query key from `getDiscussionQueryOptions(data.id)`, then invokes the caller's success callback. | A local example of detail-query refetch; it does not establish a refresh rule for other mutations. |
| [Profile update](../../apps/react-vite/src/features/users/api/update-profile.ts) | Its success handler calls `refetchUser`, obtained from `useUser`, then invokes the caller's success callback. | A distinct authenticated-user refetch example and counterexample to assuming every update selects a query through `queryClient.refetchQueries`. The authentication implementation is unavailable. |
| [Infinite comments](../../apps/react-vite/src/features/comments/api/get-comments.ts) | Its options type declares `queryConfig`, but `useInfiniteComments` destructures only `discussionId` and passes the generated infinite-query options to `useInfiniteQuery`. The declared `queryConfig` is unconsumed. | A configuration counterexample; declaring an option does not demonstrate that this hook forwards it. |

These observations are limited to these three checked hooks. Repeated create/delete scaffolding is excluded as independent convention support. The comparison does not establish a universal invalidation, refetch, or option-forwarding policy.

## Review suggestions

The following are suggestions for the particular change under review, not existing project rules:

- Identify the data consumers expected to reflect the mutation and verify that the proposed refresh target covers the task's intended outcome. Record the task-specific reason for retaining or changing the mechanism.
- For discussion updates, verify the intended detail-query target and the identifier used to select it. Do not assume this example establishes what should happen to other cached data.
- For profile updates, verify the intended authenticated-user refresh behavior using the relevant implementation when available. The visible `refetchUser` call alone does not establish authentication or API-client behavior.
- For infinite comments, clarify whether caller configuration is intended to be supported, restricted, or absent. Verify that decision against callers and observable behavior before changing the declared option or its handling; the unused declaration alone does not establish the intended fix.
- Consider task-specific behavioral checks for the affected data and intended option behavior, using the existing [testing guidance](../testing.md).

Refresh rationale and intended option behavior remain unknown. Each requires task-specific verification; these examples cannot settle either decision. The bodies of the API client and authentication implementation are unavailable in the supplied evidence, so this aid makes no claims about their response processing, authentication, token handling, or refresh internals. Findings do not extend to Next.js implementations.

## Authority and workflow boundaries

The import and development-workflow conflicts remain unresolved. [AGENTS.md](../../AGENTS.md) requires the `@/` prefix for source imports, while checked source includes relative imports; those examples do not authorize an exception. The documented end-to-end and component-generation script names differ from the supplied manifest, and the generator declares component, story, and index outputs rather than test-file output. This aid does not choose whether documentation or tooling should change. Git hook bodies remain unavailable.

All native OpenSpec controls remain authoritative at their original paths. This review aid supplies no authorization, confirmation, completion evidence, or archive eligibility:

- [Proposal](../../.agents/skills/openspec-propose/SKILL.md) authorizes planning only. After presenting planning artifacts, implementation requires a new user request and explicit transition to apply.
- [Exploration](../../.agents/skills/openspec-explore/SKILL.md) prohibits implementation. Agent-proposed artifact capture requires a direct yes/no confirmation in a separate user message after naming the files and changes; confirmation covers only that scope. A user's own explicit capture request confirms only its named scope. Design answers and silence are not write consent, and expansion requires confirmation.
- [Artifact revision](../../.agents/skills/openspec-update-change/SKILL.md) confirms every proposed edit before writing, one artifact at a time. It preserves native existing-file, partially populated glob, skipped-artifact, path, and refreshed-status checks; it does not authorize implementation or advancing the build frontier.
- [Apply](../../.agents/skills/openspec-apply-change/SKILL.md) preserves CLI-controlled states and required context-file reads. A blocked state pauses implementation; missing artifacts or tracking issues follow the native repair route. Unclear tasks, design issues, errors, blockers, and work beyond specified scope require a pause and user guidance. Tasks are complete only when their specified behavior is fully implemented, the exact returned checkbox is updated, and refreshed instructions confirm progress. Advisory guidance cannot bypass these controls.
- [Synchronization](../../.agents/skills/openspec-sync-specs/SKILL.md) uses only CLI-returned delta paths and preserves any explicit subset. It requires a valid current specs-rule snapshot before writes, preserves untouched main-spec content and established Purpose sections, and retains all missing-spec, retirement, path-containment, structural, and validation gates. Lookup failures and blocking conditions stop the affected operation; failed validation cannot be reported as success.
- [Archive](../../.agents/skills/openspec-archive-change/SKILL.md) retains separate confirmations for incomplete artifacts and incomplete tasks. Invalid or ambiguous task counts stop archive; zero tracked tasks require no task warning. Delta specs require the native combined assessment and explicit sync disposition; no returned delta paths means no sync prompt. Sync-blocked capabilities cannot be synced. A requested sync must finish synchronously and succeed, then pass structural checks and semantic comparisons for every delta capability before archive. Any sync stop, failure, or mismatch stops archive. Cancel stops the operation; an unrecognized disposition requires another answer. Native missing-main-spec, retirement, resolved-path, and archive-target collision checks remain in force. Unavailable advisory archive inputs do not block native checks or replace them.

Across these workflows, preserve native store selection, resolved-root and path checks, authorization, and confirmation requirements. Unresolved store declarations stop writes; a missing root never authorizes implicit initialization. The native distinction between auto-selected and explicitly requested OpenSpec workflows remains unchanged. Runtime context and advisory guidance cannot override built-in instructions, explicit user choices, CLI-controlled values, or human gates. Supplied files do not establish runtime readiness, task completion, successful synchronization, or archive eligibility.

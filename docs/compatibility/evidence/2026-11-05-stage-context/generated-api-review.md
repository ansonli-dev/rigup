# React Vite API cache and configuration review

This supplement supports implementers and reviewers working on the four checked React Vite hooks below. [API Layer](../api-layer.md) remains the existing authority for request declarations; its resolved guidance is not repeated here. These observations are bounded local patterns with unestablished independent provenance. They do not establish project-wide conventions or behavior in other applications.

## Review the affected data and refresh choice

The checked mutation hooks use distinct mechanisms:

| Checked hook | Refresh initiated in its success handler | Caller callback |
| --- | --- | --- |
| [useCreateComment](../../apps/react-vite/src/features/comments/api/create-comment.ts) | Calls `invalidateQueries` with the query key from `getInfiniteCommentsQueryOptions(discussionId)`; the [checked comments options](../../apps/react-vite/src/features/comments/api/get-comments.ts) define that key as `['comments', discussionId]`. | Invokes the supplied `onSuccess` afterward. |
| [useUpdateDiscussion](../../apps/react-vite/src/features/discussions/api/update-discussion.ts) | Calls `refetchQueries` with the query key obtained from `getDiscussionQueryOptions(data.id)`. | Invokes the supplied `onSuccess` afterward. |
| [useUpdateProfile](../../apps/react-vite/src/features/users/api/update-profile.ts) | Calls `refetchUser`, obtained from `useUser`, for the authenticated user. | Invokes the supplied `onSuccess` afterward. |

Discussion-query refetching and authenticated-user refetching are counterexamples to treating comments invalidation as a universal refresh mechanism. The omitted discussion-options and authentication implementations do not establish further key details or refresh guarantees.

**Review suggestion:** Identify which data a proposed change affects and why its refresh mechanism fits the feature's requirements. These examples alone do not justify standardizing all hooks on one mechanism.

## Separate initiation from completion

In all three checked mutation success handlers, the refresh call appears before the caller's `onSuccess` invocation. None of these handlers awaits the refresh call. Initiating refresh first therefore does not establish that refresh has completed, or that fresh data is available, when the caller callback runs.

**Review suggestion:** Clarify whether caller behavior depends on starting refresh or on completed refresh. If completion matters, seek requirements and evidence for that guarantee rather than inferring it from statement order. Intended completion guarantees, runtime failure behavior, and caller expectations remain unknown; this supplement does not prescribe an implementation change.

## Check accepted configuration against consumption

In [useInfiniteComments](../../apps/react-vite/src/features/comments/api/get-comments.ts), `UseCommentsOptions` contains an optional `queryConfig` property. The hook destructures only `discussionId` and passes the generated infinite-query options to `useInfiniteQuery`; it does not consume or forward `queryConfig`.

An accepted property in this options type is therefore not evidence that its configuration takes effect. Whether this mismatch is intentional remains unresolved. The supplied evidence does not establish automatic forwarding, an intentional API restriction, or a mandated repair.

**Review suggestion:** Compare configuration a caller expects to influence the query with the properties the hook actually consumes. Resolve the intended contract before proposing forwarding, removal, or another change; none is required by these observations.

## Authority and change boundaries

These review suggestions do not authorize implementation or replace [project guidance](../../AGENTS.md). The previously identified workflow and generator discrepancies remain unresolved at that original authority.

Native OpenSpec controls remain at their original paths: [exploration](../../.agents/skills/openspec-explore/SKILL.md), [planning revisions](../../.agents/skills/openspec-update-change/SKILL.md), [proposals](../../.agents/skills/openspec-propose/SKILL.md), [implementation](../../.agents/skills/openspec-apply-change/SKILL.md), [spec synchronization](../../.agents/skills/openspec-sync-specs/SKILL.md), and [archival](../../.agents/skills/openspec-archive-change/SKILL.md). Their scoped confirmations, planning boundaries, blocked states, conditional-skip handling, task-count checks, sync choices, and verification requirements remain controlling. This supplement provides no substitute workflow or approval.

The evidence is limited to the supplied bodies. Omitted callers, tests, library helpers, authentication internals, and exact locked dependency versions have not been verified. Refresh guarantees and implementation intent remain open questions.
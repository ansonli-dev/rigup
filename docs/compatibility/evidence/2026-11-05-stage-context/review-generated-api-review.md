# React Vite API cache review guidance

For implementers and reviewers working on the four checked hooks below, this supplement addresses refresh choices, caller callbacks, and infinite-query configuration. [API Layer](../api-layer.md) remains the existing authority for request declarations; its resolved guidance is not repeated here.

These findings are bounded local patterns. Independent implementation provenance has not been established, and repeated scaffolding does not establish a project convention. They do not establish behavior for unchecked hooks or other applications.

## Refresh choices and caller callbacks

| Checked mutation hook | Refresh initiated in its success handler | Caller callback |
| --- | --- | --- |
| [useCreateComment](../../apps/react-vite/src/features/comments/api/create-comment.ts) | Calls `invalidateQueries` with the query key from `getInfiniteCommentsQueryOptions(discussionId)`. The [checked comments options](../../apps/react-vite/src/features/comments/api/get-comments.ts) use `['comments', discussionId]`. | Invokes the supplied `onSuccess` afterward with the handler arguments. |
| [useUpdateDiscussion](../../apps/react-vite/src/features/discussions/api/update-discussion.ts) | Calls `refetchQueries` with the query key from `getDiscussionQueryOptions(data.id)`. The helper body is not supplied here. | Invokes the supplied `onSuccess` afterward with `data` and the remaining arguments. |
| [useUpdateProfile](../../apps/react-vite/src/features/users/api/update-profile.ts) | Calls `refetchUser`, obtained from `useUser().refetch`. The authentication helper body is unavailable. | Invokes the supplied `onSuccess` afterward with the handler arguments. |

The discussion and profile examples are counterexamples to treating comment invalidation as a universal refresh mechanism. Each checked mutation extracts the caller's `onSuccess` and invokes it from its own success handler after initiating the listed refresh.

**Initiation order is not completion order.** None of these three hooks awaits its refresh call. Their bodies therefore do not establish that refreshed data is available when the caller callback runs. Intended refresh guarantees and implementation intent remain unknown.

Review suggestions, rather than existing project rules:

- Identify the affected data and the actual refresh mechanism for the hook under review; avoid copying a mechanism solely because another checked hook uses it.
- Check whether caller behavior depends on refresh initiation or refresh completion. If completion matters, seek evidence for that guarantee rather than inferring it from callback placement.
- When reviewing callback composition, compare the caller's required arguments and timing with the checked handler. The examples alone do not authorize changing either contract.

## Infinite-comments configuration

In [useInfiniteComments](../../apps/react-vite/src/features/comments/api/get-comments.ts), `UseCommentsOptions` contains an optional `queryConfig` property, but the hook destructures only `discussionId`. Its `useInfiniteQuery` call spreads the options returned by `getInfiniteCommentsQueryOptions(discussionId)` and does not consume or forward `queryConfig`.

Acceptance by the options type does not establish runtime forwarding. Whether the omission is intentional remains unresolved. The supplied body establishes neither an intentional design choice nor a mandated repair.

Review suggestion: trace any configuration a caller expects to affect the query through to the actual query options. If a caller depends on `queryConfig`, clarify the intended contract before proposing a change. Forwarding configuration, changing the accepted type, and retaining the current behavior are decisions requiring further context; this supplement selects none of them.

## Evidence limits and native gates

The observations above are limited to the four linked hook files. Omitted callers, tests, shared configuration, authentication helpers, and dependency internals have not been verified. Exact locked dependency versions, refresh completion guarantees, and implementation intent remain unknown.

This review guidance grants no implementation authorization and replaces no native workflow. Where applicable, the original [exploration](../../.agents/skills/openspec-explore/SKILL.md), [proposal](../../.agents/skills/openspec-propose/SKILL.md), [planning revision](../../.agents/skills/openspec-update-change/SKILL.md), [implementation](../../.agents/skills/openspec-apply-change/SKILL.md), [synchronization](../../.agents/skills/openspec-sync-specs/SKILL.md), and [archive](../../.agents/skills/openspec-archive-change/SKILL.md) instructions retain their scopes, confirmations, exceptions, blocked states, and verification requirements at those paths. In particular, discovery answers do not authorize writes, proposal completion does not authorize implementation, planning revisions retain per-edit confirmation, and archival retains its native completion and selected-sync gates. Runtime applicability and readiness have not been established by this review.

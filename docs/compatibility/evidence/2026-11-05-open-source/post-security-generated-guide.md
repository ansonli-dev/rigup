# React Vite E2E readiness

This guide supports contributors preparing React Vite E2E verification and reviewers assessing readiness. It records checks and unresolved decisions from the supplied application sources. It does not establish a successful run or a repository-wide convention.

Use the original [testing guide](../testing.md), [project instructions](../../AGENTS.md), [project structure guidance](../project-structure.md), and [security guidance](../security.md) for their existing rules. The checks below supplement their application-specific coverage.

## URL resolution and frontend prerequisites

**Observed:** [Playwright configuration](../../apps/react-vite/playwright.config.ts) describes frontend startup on port `3000`, a ten-second startup timeout, and reuse of an existing server outside CI. Reuse is disabled when `CI` is truthy. Its `baseURL` example is commented out; the dotenv-loading example is also commented out.

[Authentication setup](../../apps/react-vite/e2e/tests/auth.setup.ts), [profile](../../apps/react-vite/e2e/tests/profile.spec.ts), and [smoke](../../apps/react-vite/e2e/tests/smoke.spec.ts) all use relative navigation. None of these supplied bodies establishes an effective Playwright base URL or a local override. The application `APP_URL` default does not configure Playwright.

**Readiness checks, not existing rules:** Establish the effective Playwright configuration and how relative URLs resolve before relying on navigation. Identify whether invocation supplies external configuration. When reusing port `3000`, verify that the responding frontend is the intended application with the intended environment. Server startup or port availability alone does not establish API readiness. URL resolution remains unresolved in the supplied evidence.

## Authentication setup and state consumption

**Observed:** The setup project matches setup files. Chromium matches spec files, depends on setup, and loads `e2e/.auth/user.json`. The supplied setup creates user data, navigates through registration including a team name, signs out, signs back in with the same credentials, and saves browser storage state at that path.

Profile and smoke consume this configured state; neither registers a user independently. Profile changes the bio to `My bio` and checks its visibility. Smoke exercises discussion creation and editing, comment creation and deletion, and discussion deletion.

**Readiness checks:** Verify that the selected invocation retains the setup dependency, that setup can complete against the selected API, and that its saved state remains usable by Chromium. The saved file alone does not prove server-side session validity or production authentication protections. Chromium browser prerequisites have not been verified.

## Separate mock mechanisms and environment prerequisites

**Observed:** The [application manifest](../../apps/react-vite/package.json) describes a `test-e2e` script that starts a PM2-managed mock-server process named `server` before Playwright. Its separate `run-mock-server` entry references a mock-server entrypoint. The entrypoint body is unavailable, so the manifest does not establish API readiness, database behavior, or process cleanup.

The [browser mocking entrypoint](../../apps/react-vite/src/testing/mocks/index.ts) is a separate mechanism. If `env.ENABLE_API_MOCKING` is truthy when `enableMocking` is invoked, it imports the browser worker and database initializer, awaits database initialization, then starts the worker. Application startup's invocation of this function and the worker/database implementation bodies are not supplied. There is no evidence that this browser database shares persistence with the separate mock process.

The [environment parser](../../apps/react-vite/src/config/env.ts) selects only `import.meta.env` keys beginning with `VITE_APP_` and removes that prefix before parsing:

| Parsed field | Visible requirement or default |
| --- | --- |
| `API_URL` | Required string; no URL-format or endpoint-reachability validation is shown. |
| `ENABLE_API_MOCKING` | Optional string accepting exactly `true` or `false`, transformed to a boolean. |
| `APP_URL` | Optional string defaulting to `http://localhost:3000/`. |
| `APP_MOCK_API_PORT` | Optional string defaulting to `8080`; no port-range validation is shown. |

Invalid parsed input causes an error. These defaults are source values, not evidence of actual runtime environment values, a listening API, or Playwright URL configuration.

**Readiness checks:** Establish the actual filtered environment, intended API target, mock-process readiness, and whether browser mocking is invoked and enabled. Verify each mechanism independently; do not infer readiness or shared persistence from the other mechanism's startup.

## Unresolved script guidance

**Needs decision:** [AGENTS.md](../../AGENTS.md) names `test:e2e`, while the [application manifest](../../apps/react-vite/package.json) declares `test-e2e`. The documented component identifier `generate:component` also differs from the manifest's `generate`. AGENTS.md describes generated tests, while the supplied [component generator](../../apps/react-vite/generators/component/index.cjs) declares index, component, and story outputs only.

Explicit project guidance retains its authority. This supplement neither silently substitutes manifest identifiers for that guidance nor decides which original source should change. Reconcile the source-level conflict before treating an invocation as agreed guidance. Script behavior, generator resolution, installed dependencies, tools, and browser prerequisites have not been verified.

## Isolation and cleanup limitations

**Scoped evidence:** Smoke explicitly deletes its created comment and discussion and asserts their removal through the UI. That is a local example, not proof of general database isolation, cleanup after failure, or a repository-wide cleanup policy.

Setup user cleanup, restoration or persistence of profile changes, interactions between tests using the same authenticated identity, and mock-process teardown remain unknown. Playwright enables full parallelism and limits CI workers to one; those settings do not establish data isolation.

**Readiness checks:** Determine the intended data lifecycle and cleanup responsibilities, including failed runs and shared authentication state. Keep these as unresolved prerequisites until implementation or execution evidence establishes their behavior.

## Verification boundaries

No supplied execution results establish build, lint, type-check, unit, integration, or E2E success. Configuration and test assertions describe intended behavior; they are not execution results.

Unavailable bodies include the mock-server entrypoint, API client, authentication and authorization implementations, test utilities, data generators, mock database, mock utilities, and authentication handlers. Their absence from this evidence does not imply file absence. Application startup and browser-worker configuration are omitted, as are lint configuration, README bodies, project-standards documentation, and OpenSpec configuration. Inventory paths provide navigation only.

The lockfile body is omitted, so exact locked and transitive dependency versions cannot be inferred from manifest ranges. Git-hook and CI bodies are not supplied; AGENTS.md enforcement declarations have not been verified operationally. Prior README and import-style findings do not resolve conflicts or relax explicit project guidance. Mock behavior and saved browser state cannot establish production authentication, real server authorization, token refresh, error tracking, or source-map upload.

**Recommended review evidence:** Record the effective URL configuration, actual environment interpretation, frontend and API readiness, selected projects and setup outcome, session usability, isolation and cleanup behavior, and actual verification results. Keep unperformed checks explicitly unverified.

## Native workflow boundaries

Readiness findings do not replace native OpenSpec workflows, their resolved roots, CLI-controlled state, artifact rules, or user choices. Follow the originals when work enters those workflows:

- [Explore](../../.agents/skills/openspec-explore/SKILL.md): exploration does not implement. Capture requires confirmed files/artifacts and scope; design answers are not write confirmation. A user's explicit capture request confirms only its requested scope, and expansion requires confirmation.
- [Propose](../../.agents/skills/openspec-propose/SKILL.md): planning ends after presenting artifacts. Implementation requires a new user request afterward, even if the initial request also asked for implementation.
- [Revise](../../.agents/skills/openspec-update-change/SKILL.md): every artifact edit requires confirmation before writing. Its narrowly permitted new concrete file under an already partially populated glob artifact remains subject to all native scope and refreshed checks.
- [Apply](../../.agents/skills/openspec-apply-change/SKILL.md): preserve blocked-state handling and pauses for ambiguity, design issues, errors, blockers, user interruption, or added scope. Do not silently narrow, defer, or accept exceptions to specified behavior. Completion requires implemented behavior and refreshed task verification.
- [Sync](../../.agents/skills/openspec-sync-specs/SKILL.md): preserve CLI-selected delta paths and any explicitly narrowed subset, required specs-instruction checks, semantic preservation, and validation. A blocking condition or failed validation cannot be reported as successful sync.
- [Archive](../../.agents/skills/openspec-archive-change/SKILL.md): incomplete artifacts and tasks retain their warnings and user confirmations. Failed or invalid task-count lookup stops before syncing or archiving. Preserve combined delta assessment and the native sync, skip, and cancel choices; sync-blocked capabilities do not permit starting sync. A selected sync requires valid specs instructions, synchronous completion, structural verification, and comparison of every delta capability before moving the change. Failed selected sync or verification stops archiving. The optional advisory-input lookup is the explicit exception: its failure continues without context or operation guidance and does not block archive.

# GitLab CI validation boundary — 2026-11-03

Local tests validate source-compatible YAML include insertion without replacing customer jobs/includes/comments, selected snapshot command exit codes, report preservation after a failed check, source-only wiki job rules and generated-update skip guards. These are local contracts, not GitLab server acceptance.

Live CI lint: **pending**. This environment has no GITLAB_TOKEN, GITLAB_HOST or CI_PROJECT_ID. No project endpoint was guessed, no credentials were exported, and no customer YAML was sent to a third-party project. The official [CI Lint API](https://docs.gitlab.com/api/lint/) validates in a specified project and resolves local includes against its repository; a real target/ref with the generated include committed is needed for that check.

Source references checked: [local includes](https://docs.gitlab.com/ci/yaml/includes/), [job rules](https://docs.gitlab.com/ci/jobs/job_rules/), [Git hook input contracts](https://git-scm.com/docs/githooks).

OpenWiki CI provisioning and model credentials remain runtime prerequisites. The installed updater never silently installs/initializes, commits or pushes. Missing prerequisites return pending (exit 3). No live OpenWiki model update was performed by the local contract fixtures.

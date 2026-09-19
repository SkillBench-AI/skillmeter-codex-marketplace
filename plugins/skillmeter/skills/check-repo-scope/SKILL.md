---
name: check-repo-scope
description: Check whether the current repo belongs in the user's allowed GitHub org scope.
---

Inspect the nearest Git repository, resolve its GitHub remote owner and compare
it with the user's allowed scope. Report whether it matches, is excluded, has
no Git repository, or has no recognizable GitHub remote. Non-GitHub remotes are
outside GitHub-owner filtering.

Scope can be narrowed through:

- `signin --org your-github-org`: stored sign-in scope.
- `SKILLMETER_REPO_SCOPE_ORGS`: comma-separated environment filter.
- `skillmeter.repoScopeOrgs` in `.codex/settings.local.json`: project filter.

Filters intersect with signed-in identities; they cannot add access. If the
user requests a batch export, use the matching
`skillbench collect --allowed-orgs ...` command.

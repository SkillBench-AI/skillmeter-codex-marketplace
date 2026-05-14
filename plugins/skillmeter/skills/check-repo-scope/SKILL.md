---
name: check-repo-scope
description: Check whether the current repo belongs in the user's allowed GitHub org scope.
---

Use this skill when the user wants to know whether a workspace should be
included in SkillBench collection.

Workflow:

1. Inspect the nearest Git repository for the current workspace.
2. Resolve the best available Git remote and extract the GitHub org when
   possible.
3. Compare that org with any allowed-org list the user provides.
4. Explain one of the following outcomes clearly:
   - approved GitHub org match
   - GitHub repo outside the allowed org list
   - no Git repository
   - no recognizable GitHub remote
5. If the user wants to proceed with collection, suggest or run the matching
   `skillbench collect --allowed-orgs ...` command.

Guardrails:

- Keep the explanation concrete and repo-specific.
- If the remote is not GitHub-backed, explain that SkillBench will treat it as
  out of scope for GitHub-org filtering.

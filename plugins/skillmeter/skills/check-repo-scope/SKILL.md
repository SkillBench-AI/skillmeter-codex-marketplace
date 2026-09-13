---
name: check-repo-scope
description: Check the current repository against the license organization and shared telemetry consent.
---

Use the plugin's `scripts/telemetry.js status` from the current repository.
It resolves canonical GitHub identity using the same gate as capture, including
clones/worktrees, organization consent, repository consent and legacy local OFF.
Explain the reported gate without printing the JWT or credentials file.

Only the single organization in the current license establishes eligibility.
User-supplied membership lists and legacy scope settings cannot authorize capture.
If the user requests capture, use the existing telemetry enable command from the
eligible repository. Do not infer consent from membership or sign-in alone.

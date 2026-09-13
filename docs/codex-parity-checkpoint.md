# Codex parity candidate checkpoint

September 13, 2026. This is a source-only, dependent follow-up to transport PR #35.
It is not ready for release or a request for engineering review.

Base: remote `codex/telemetry-m0-20260904` at `84f48f3974881a5ad06af5d25a32af5bb4f93eee`.
Claude reference: `0ea513751149a23fcc063fb8f045794657ceb031` (0.34.1).
Both main refs were fetched again before implementation and remained unchanged.

## Completed: authenticated delivery

Events now require a valid stored token and a trusted audience-derived destination.
Missing/invalid routing has no production fallback. A configured development
override still requires a valid token. Event 401/402/403 responses retain the batch
and credentials without an anonymous retry or consuming the payload retry budget.
Transcript delivery also rejects mismatched destinations. Refresh/lifecycle rules
remain a separate follow-up under INF-177.

Validation: baseline 229 tests passed. Eleven new failing compatibility cases were
recorded before the fix; all pass afterward. Full `npm run check`: 240 passed.
Existing local HTTP tests still exercise actual request handling, using a test-only
transport interceptor for the synthetic licensed host. No live telemetry was sent.

## Next

Adopt the shipped canonical consent policy and repository queue boundaries, with
license-org scope and durable transcript exclusions. Then port pinned sanitizer
fixtures and rules, retaining the existing command/patch hashing policy.
Keep unfinished ADR001 lifecycle work out of this candidate. Coordinate scope with
Seungho before requesting review; check Brandon's ATLAS collector overlap.

Original dirty checkouts remain untouched. Baseline fingerprints and local test
logs are in `reports/codex-consent-parity-2026-09-13/` at the workspace root.
The isolated worktree is `.worktrees/codex-consent-parity-20260913` there.

Release still requires a real installed Codex CLI/desktop session, explicit consent,
scoped delivery/storage, shared preprocessing, the existing real AI-usage analyzer,
and the matching report for the correct user on the existing dashboard. Production
deployment, schedules, historical replay and publication are not authorized here.

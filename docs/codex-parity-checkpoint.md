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

## Completed: canonical consent and Codex queues

Copied Claude's `io`, `repo-scope`, `telemetry-policy` and `telemetry-store` from
`skillmeter/scripts/lib` at the pinned reference above. The only store deviation
is a Codex safeguard rejecting invalid/future schemas without overwriting them.
The policy location and writer protocol match Claude. The small config adapter
retains existing activation settings. `getLicenseOrgs` incorporates the original
local auth change without changing that dirty checkout; the remaining original
sign-in/auth edits still need separate reconciliation.

Capture requires licensed-org eligibility and explicit organization/repository
consent; legacy OFF survives. Queues bind canonical repository, principal, device
and consent. Revocation retires payloads; global pause retains authorized queues.
Event delivery is serialized per batch; poison files retain repository scope.
State falls back to `~/.skillbench/codex`, never the plugin installation.

Codex's durable byte journal excludes pre-observation and disabled intervals,
including full-baseline recovery, partial lines and source rewrites. Hook
observations use file stats; background recovery may verify the committed prefix.
Malformed journals fail closed. Full `npm run check`: 250 passed; `git diff --check`
passed. Tests use isolated synthetic credentials, policies, repositories and data.

## Next and unresolved limits

Port pinned sanitizer fixtures and rules, retaining command/patch hashing.
Then review the whole candidate and open a dependent draft follow-up to PR #35.
Keep unfinished ADR001 lifecycle work out of this candidate. Coordinate scope with
Seungho before requesting review; check Brandon's ATLAS collector overlap.

The first observation excludes the existing transcript prefix. Real Codex hook
ordering must establish whether a newly authorized session's opening records are
already present then. Do not claim complete session capture until verified and,
if necessary, repaired. Auth lifecycle intervals without any hook observation
also need validation with the eventual ADR001 refresh/signout implementation.
A queue's first checkout path remains a validation hint; removing that checkout
can block delivery even if another clone exists. The shared Claude writer uses
its existing timestamp-based policy lock; its broader redesign is not included.

Original dirty checkouts remain untouched. Baseline fingerprints and local test
logs are in `reports/codex-consent-parity-2026-09-13/` at the workspace root.
The isolated worktree is `.worktrees/codex-consent-parity-20260913` there.

Release still requires a real installed Codex CLI/desktop session, explicit consent,
scoped delivery/storage, shared preprocessing, the existing real AI-usage analyzer,
and the matching report for the correct user on the existing dashboard. Production
deployment, schedules, historical replay and publication are not authorized here.

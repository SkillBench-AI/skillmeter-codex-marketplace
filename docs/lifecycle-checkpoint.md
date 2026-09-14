# Codex lifecycle checkpoint, 2026-09-14

Bounded work completed: consented repository provenance repair and an offline
ADR001 acceptance harness. Full lifecycle repair and live release are incomplete.

Branch: `codex/consent-queue-parity-20260913`, stacked draft
[PR #37](https://github.com/SkillBench-AI/skillmeter-codex-marketplace/pull/37).
Production-code revision tested: `54ce356` (repository-name repair), based on
`8d9e51d`. Claude reference is 0.34.1 at
`0ea513751149a23fcc063fb8f045794657ceb031`. The harness commit changes no runtime
authentication code, shared policy schema or sanitizer engine.

## Evidence

- `npm run check`: 413 tests passed, zero failures/skips; version and manifest checks passed.
- Five new stdin-hook tests reproduced repository identity spoofing before the
  repair and passed afterward. They verify consent exclusions, sanitized queue
  contents and identical gzip-upload contents, including policy counts of zero.
- `npm run check:lifecycle`: **7 passed, 27 failed, zero fixture errors** across
  34 cases; exit 1. See [complete synthetic outcomes](lifecycle-baseline.json).
- The seven passing cases cover healthy-token no-op, empty-queue background
  refresh, no expired-token delivery, refresh-before-draining both queues,
  signed-out recovery suppression, and repository/organization OFF purge.
- Failure cases overlap requirements; 27 failures do not mean 27 independent
  bugs. A case stops at its first failed assertion. Later assertions in that
  case remain unverified. The harness README records additional coverage limits.

## Remaining implementation

1. Adopt Claude's typed refresh outcomes, shared status and refresh coordination:
   transient errors must retain the token without activation, with bounded
   exponential backoff, terminal status and explicit session/sign-in reset.
2. Bind recovery to a prior successful sign-in. Check current GitHub identity
   before activation and minted github_id/sub/org/audience before commit. Cover
   missing-marker upgrade behavior and process races before changing shared auth.
3. Separate expired-token capture from fresh-token delivery. Preserve repository,
   principal, consent-byte and structured transcript identity across refresh.
4. Purge unsent event/chunk payloads on logout and refresh/activate 402; enforce
   seven-day retention, including protection against restaging deleted old data.

First next-session action: recheck Seungho's INF-177 scope and current Claude
ADR001 implementation, then choose the first bounded lifecycle change using
the failing cases above. Reuse these worktrees and keep the original dirty
checkouts and prior canary directories untouched. Do not replace the accepted
ADR with Codex-specific auth semantics. No new cloud setup is needed for source
work; this checkpoint does not authorize edits to shared live credentials.

## Exact remaining live-canary steps

1. Obtain approved scoped development access and confirm the selected tenant,
   intended user identity and existing report/dashboard destination with Seungho
   and Homin. The existing local license audience is production; do not reuse it
   as a development credential or copy it into a handoff.
2. Confirm reviewed candidate revisions for plugin PR #37, collector PR #44
   (remote `8699008`, tree-equivalent to local `6dc8806`) and pipeline PR #148
   (`f9f45d2`). Resolve lifecycle release scope before promoting these drafts.
3. Have the authorized owner deploy the collector and parser candidates only
   to the selected development tenant with a recorded rollback. The existing
   pipeline workflow deploys multiple dev tenants and must not be dispatched
   as a shortcut. Verify running revisions, not merely branch heads.
4. Prepare a new isolated Codex CLI/desktop canary pinned to the reviewed plugin
   revision, perform the explicit development sign-in and repository consent,
   and complete a short real session with tool calls, repeated content and resume.
   The prior local CLI 0.154.0 canary used plugin `8d9e51d`, so it does not prove
   the new repository-name field or unimplemented lifecycle behavior.
5. Trace that session's authenticated chunks through collector storage and the
   shared preprocessor, check record continuity/structured tools/source identity,
   run the existing AI-usage analyzer, and verify its real report on the existing
   dashboard for the intended user. Save sanitized counts and source pointers.

There was no production deployment, merge, release, schedule change, historical
replay or real-session upload in this bounded work. This is source/test evidence,
not end-to-end completion. Runtime logs remain outside Git; the committed JSON
contains synthetic case outcomes only.

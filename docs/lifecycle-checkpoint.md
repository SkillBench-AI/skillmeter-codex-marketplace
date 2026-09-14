# Codex lifecycle checkpoint, 2026-09-14

The 27 previously failing acceptance checks are repaired. The expanded offline
suite passes 55/55; regular regressions pass 414/414. Source implementation and
local compatibility evidence are complete for this pass. Production release and
the real dashboard canary remain incomplete.

Branch: `codex/consent-queue-parity-20260913`, stacked draft
[PR #37](https://github.com/SkillBench-AI/skillmeter-codex-marketplace/pull/37).
Worktree: `/Users/juhokim/Code/skillbench-all/.worktrees/codex-consent-parity-20260913`.
M1 commit: `a9b6eac`; the next commit contains M2 hardening and this checkpoint.
Claude main was fetched and remains `0ea513751149a23fcc063fb8f045794657ceb031`.

## Evidence

- `npm run check`: version/manifests, 414 regular tests and 55 strict lifecycle
  acceptance checks passed, with no failures or skips.
- The original 7-pass/27-fail baseline is preserved in `lifecycle-baseline.json`;
  current synthetic outcomes are in `lifecycle-repaired.json`.
- Tests cover refresh-only transient recovery, identity-bound reactivation,
  expiry-time capture with fresh-token delivery, terminal status/reset, seven-day
  deletion, logout/402 purge, legacy payload removal, interrupted purge recovery
  and preventing retired transcript reconstruction.
- A separate-process regression verifies lock exclusion and recovery after a
  crash. Snapshot/generation cases verify that late refresh results cannot
  overwrite or revoke a newer Codex sign-in.
- The existing synthetic Node → Go collector/storage → HTTP S3 emulator → shared
  parser → existing analyzer/ingest-schema contract passed: 40 records, one
  canonical session, 21 messages, repeated records, lost-response retry,
  multi-day resume and stale-generation protection. LLM responses were scripted;
  no dashboard or real model invocation is claimed.
- Regression fixtures changed only where the accepted contract required it:
  identity-bearing JWTs, realistic sweep timing, and deleting expired payloads
  instead of preserving/quarantining them. Inventory remains read-only.

## Remaining risks and first resume action

First: review the two implementation commits with Seungho under INF-177,
particularly the additive `prior_signin` and `auth_generation` fields. Current
Claude has not shipped A4 and does not acquire Codex's credential lock. Snapshot
checks protect against observed intervening writes, but an uncoordinated Claude
write during Codex's final filesystem commit is not proven safe. Align the
writers before installing this candidate into a shared real-user environment.
The shared status schema/engine is copied from Claude without changes.

Activation server main `f5e6033359de960e81fafe3e72f7f207c27ca84b` was inspected:
`jwt.go` emits string `aud`/`sub`, numeric `github_id` and `org.login`, matching
the recovery identity validator. It still mints 15-minute tokens. This client
reads token expiry and works with that TTL; the ADR's one-hour server rollout
is a separate change and was not performed here.

Native hook re-review, an installed-client upgrade/rollback, real token expiry
and server revocation still need scoped validation. A corrupt retirement
journal blocks that source; source recovery must be explicit, never automatic
historical replay. INF-195 per-file consent and stage-2 sanitizer work remain
outside this change. Original dirty checkouts, live credentials and previous
canary runtimes were not modified.

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

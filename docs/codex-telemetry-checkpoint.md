# Codex telemetry source checkpoint, 2026-09-05 UTC

Repair branch: `codex/telemetry-m0-20260904`, baseline
`13b4648761aae7e9ebb20477276c13a416460173`.
Draft PR: https://github.com/SkillBench-AI/skillmeter-codex-marketplace/pull/35.
Pipeline draft: https://github.com/SkillBench-AI/skillbench-pipelines/pull/148.
Portable full brief and parser checkpoint are in the pipeline branch at
`docs/codex-telemetry-repair-handoff.md`.

Source implementation: immutable gzip chunk transactions, raw complete-byte
cursor with prefix HMAC/file identity, monotonic sequence/reset baselines,
raw-position transport UUIDs, ordered PID-locked staging/draining, published
transaction recovery, real gzip/base64 budgeting, partial-line retention,
actionable staging/HTTP diagnostics, scope checks at capture and every send,
read-only credential refresh, bounded SessionEnd/Interrupt capture hints, and
read-only legacy queue inventory. Nested Codex metadata cwd is HMAC-hashed.
No auth configuration changes, anonymous transcript fallback, historical replay,
release/version bump, deployment, merge, or schedule activation occurred.

Evidence: `npm run check` passes 222 tests (no skips/TODOs), including the original
missing-header fixture, interrupted transactions, restart, competing drains,
response loss, repeated records/redaction collisions, rewrites, scope/user/device
changes, expired/rejected auth, legacy preservation and sub-three-second shutdown.
Existing event/auth tests remain green. Node 22.22.3, Go 1.25.5, Python 3.14.6.

The optional `plugins/skillmeter/integration/run_contract.py` now exercises the
actual Node uploader, Go APIHandler/EventProcessor/PromptStore, HTTP S3 emulator,
shared parser and existing analyzer with scripted LLM responses. With the pipeline
substantive fixture: exact 40 stored records, one canonical session, 21 messages,
legitimate repeats retained, and an ingest-schema-valid versioned report using the
default ten-block minimum. API Gateway/JWT verification is outside this harness.

Multi-day fix: opt in with `X-Transcript-Protocol: codex-chunks-v1`. The compatible
collector change returns 409 `transcript-baseline-missing` when its today/yesterday
lookup lacks the requested generation. The client durably requests a higher
sequence full reset, rechecks source scope/consent, and retains superseded queue
files without sending them. Tests cover midnight append, three-day resume,
response loss, missing source, consent revocation and stale generation replay.
Deploy the compatible collector fix before installing this client. The old
collector ignores the opt-in header and cannot protect multi-day continuity.

Queue ownership binds tenant `sub` AND GitHub/user identity. `sub` alone names the
tenant and cannot distinguish users. Tokens without a user claim fall back to
token identity and require a new capture after rotation. Pre-release cursors
created with the earlier owner formula stay preserved and fail closed; do not
manually overwrite their owner fields to migrate them.

Remaining: actual backend ingest/read and correct-user dashboard proof, scoped
model/auth/deployment access, CLI/desktop install/upgrade/rollback smoke, GStack
release review and versioned artifact preparation. Original auth/org edits need
explicit release reconciliation. No release-ready or end-to-end claim is made.
Keep all repair PRs draft and unmerged. Upload-day window selection remains the
existing policy; only duplicate Codex snapshots within one window are collapsed.

Runtime dependencies were installed only in the workspace. Original dirty
checkouts, including local Codex auth/org edits, remain separate and must not be
reset, stashed, overwritten, or automatically included in a release. Before
release, review whether any of those edits must be carried forward.

Git HTTPS/SSH transport was unavailable. Connector-created remote commits are
content-identical backups with different commit metadata; do not assume local
and remote commit SHAs match. Compare tree SHAs before advancing remote branches.

## Review and hardening checkpoint

See `docs/codex-telemetry-review.md` for five reproduced defects and fixes,
SIGKILL recovery tests, independent record/canonical expectations, and the measured
64 MiB capture cost. Current plugin suite: 229 passed. Pipeline parser: 128 passed;
analyzer: 308 passed. All original code/scoping boundaries remain preserved.
Ready-for-review is recommended after updated CI; ready-to-merge/release is not
claimed. Existing PRs stay draft until the user requests the status change.

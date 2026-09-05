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

Evidence: `npm run check` passes 217 tests (no skips/TODOs), including the original
missing-header fixture, interrupted transactions, restart, competing drains,
response loss, repeated records/redaction collisions, rewrites, scope/user/device
changes, expired/rejected auth, legacy preservation and sub-three-second shutdown.
Existing event/auth tests remain green. Node 22.22.3, Go 1.25.5, Python 3.14.6.

The optional `plugins/skillmeter/integration/run_contract.py` drives the actual
Node uploader, Go EventProcessor/PromptStore, HTTP S3 emulator, and shared parser.
It passed: request attempts seq/reset `1/1, 1/1, 2/1`, exact 11 stored records,
one canonical Codex session with five messages, both repeated messages retained.
The helper intentionally loses a response after the S3 conditional write.
It substitutes for API Gateway and does not verify deployed JWT authentication.

Remaining: multi-day resume/storage continuity and duplicate-window analysis,
long-fixture analyzer/report contract, actual backend ingest/read and dashboard,
CLI/desktop install/upgrade/rollback smoke, GStack review and release preparation.
This source checkpoint is not M4 or release completion. Never claim a real report
until one controlled in-scope Codex session appears for the intended user through
the existing dashboard. Keep PRs draft and unmerged.

Runtime dependencies were installed only in the workspace. Original dirty
checkouts, including local Codex auth/org edits, remain separate and must not be
reset, stashed, overwritten, or automatically included in a release. Before
release, review whether any of those edits must be carried forward.

Git HTTPS/SSH transport was unavailable. Connector-created remote commits are
content-identical backups with different commit metadata; do not assume local
and remote commit SHAs match. Compare tree SHAs before advancing remote branches.

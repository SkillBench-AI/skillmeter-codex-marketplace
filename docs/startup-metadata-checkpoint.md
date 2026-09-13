# Startup metadata repair, September 14, 2026

The actual isolated CLI 0.143.0 canary captured every consent-eligible record and
all 12 tool call/result pairs. Its first-observation exclusion also removed the
session header, however, causing the preprocessor to infer an incorrect session
ID from the rollout filename and lose workspace information for a short session.

The background reader now projects the excluded first session_meta record to
session ID, cwd, source and parent-thread identity, plus timestamp and record UUID
when present. It checks repository authorization and applies the existing
sanitizer. Nested subagent metadata becomes an explicit subagent marker. Unknown
structured sources and malformed required metadata fail closed. Instructions and
all other excluded records remain excluded; metadata inside the authorized range
retains its existing sanitization behavior. Hooks still observe consent using stat
only; they do not parse the source on the prompt path.

The cursor records metadata version 1. Upgrading an older cursor establishes one
monotonically sequenced full-reset snapshot using its existing consent ranges.
Paused or pre-consent conversation text is not restored. Existing committed batches
remain immutable; publication and recovery use the existing durable transaction.

Paired pipeline changes in PR148 mark missing source metadata as actionable and
set exported full_fidelity to false. The existing analyzer refuses such a window
before model calls. world_state remains explicitly unsupported when encountered
in authorized input; no raw examples from the user's canary were added to tests.

Validation: synthetic red tests reproduced the metadata gap; tests cover header
projection, scope mismatch, source UUID and lineage, unknown source shapes, cursor
upgrade across pause, revocation before commit and crash recovery. The existing
transport contract's new --startup-consent variant passes the real repaired Go
handler/store, HTTP S3 emulator, shared preprocessor, scripted analyzer and ingest
schema: 40 records, one canonical session, 21 messages, repeated prompts retained,
lost-response retry and multi-day/full-reset recovery. The pipeline/preprocessor
suite passes 447 tests. Exact run logs and counts are in the local repair report.

The original canary runtime remains pinned to the previous candidate and untouched.
A new real CLI canary is still required for this repair. The user may upgrade Codex
now; record that version separately. No real JWT verification, live collector/model
service, ingest/read-back, dashboard, desktop test, production deployment or release
was performed. Keep PR37 and PR148 draft.

Resume: run a fresh isolated real CLI canary with this candidate and the paired
pipeline change; verify original session identity, hashed workspace and tool
structure as well as prompts and consent exclusions. Then coordinate scoped
development delivery and the correct user's dashboard proof. Do not replay the
original canary or historical telemetry automatically.

# Codex telemetry review and hardening

2026-09-05 UTC. Review starting heads: plugin `30a1cec6457086e06846d1ddde16e7ea517500d0`,
pipelines `507dc5ad9b7031592a2f05fec5e49657c3f56d1c`, collector
`6dc880609ef023eb8eb3f2fb9000d208cf5f4803`. Main revisions remained unchanged.
All original checkouts remain outside the worktrees used for this repair.

This is an author-performed, GStack-checklist-guided source review. It is not
independent human/model approval. No subagents, global workflow configuration,
production access, release, deployment, or PR readiness transition were used.
The review covers the changed transport/parser/collector source, queue consumers,
synthetic integration harness and relevant tests. Live integration remains open.

## Confirmed defects fixed

- **P1, confidence 10/10: one corrupt queue stopped all later transcript drains.**
  The loop awaited each directory without an exception boundary. A corrupt cursor
  reproduced starvation. It now records a content-free `queue-unavailable`
  diagnostic, retains that queue and continues other authorized directories.
  Regression: `a corrupt queue does not block other authorized transcripts`.
- **P1, confidence 10/10: an outage looked like an idle queue to the retry monitor.**
  `drainPendingTranscripts` returned acknowledgments, while the monitor interprets
  zero as no work found. It now counts pending work before sending, preserving
  retries across failed requests. Regression: `failed transcript upload counts
  as queued work for the retry monitor`.
- **P2, confidence 10/10: canonical tool text erased known execution failure.**
  A function response without exit metadata replaced the event result, including
  its `is_error=true`; reverse arrival order also lost failure evidence. The parser
  preserves known failure while retaining canonical response text. Regression:
  `test_mirrored_tool_output_preserves_known_failure_in_either_order`.
- **P2, confidence 10/10: a session-wide reasoning filter discarded unrelated turns.**
  Any response reasoning caused all event reasoning to be ignored. Reasoning now
  uses the same nearby one-to-one mirror matching as messages; unrelated event-only
  and genuinely repeated reasoning remains. Regressions:
  `test_event_only_reasoning_is_not_lost_when_another_turn_has_response_reasoning`
  and `test_reasoning_mirrors_pair_once_and_repeated_events_survive`.
- **P2, confidence 10/10: lock release during acquisition raised ENOENT.**
  A lock could disappear between the failed exclusive link and ownership inspection.
  Missing-lock inspection now retries within the existing bound. Regression:
  `lock released between exclusive-link failure and inspection is retried`.

Every defect above was first reproduced against the previous implementation.
Red and passing logs are in the workspace hardening checkpoint directory.

## Evidence strengthened

Four subprocess SIGKILL tests now cover three transaction boundaries and death
after remote acceptance. They assert a real abandoned lock, durable recovery,
and identical retry bytes/metadata. Exception-based tests remain useful for other
faults but are no longer the sole crash evidence. This verifies process death;
it does not simulate hardware power loss or filesystem failure.

The cross-repository test now checks all stored records against independently
specified fixture expectations, including nested email/credential redaction
canaries. It also compares all original canonical messages, tool blocks and
timestamps against the golden authored before parser implementation. The older
staged-byte comparison remains as a separate delivery-fidelity check.

A reproducible 64 MiB synthetic capture measurement found unchanged capture read
128 MiB. A verified-prefix early return reduces it to 64 MiB, retaining rewrite
detection. One warm-cache measurement moved from 64 ms to 34 ms. Appending still
reads about 192 MiB to verify and extend the prefix (roughly 130–177 ms in these
samples); it remains linear in transcript size. This is not a portable latency
promise, a hard staging-time bound, or validation across many retained hints.
Raw work remains in the detached process. No unsafe metadata-only shortcut or
new fingerprint scheme was introduced.

The integration runner was expanded into readable phases; Python formatting,
stale queue comments and the README's incorrect event/transcript storage diagram
were corrected. An unused drain return value was removed. No new runtime
framework, scoring rule, service, or general-purpose abstraction was added.

## Validation and readiness

Plugin full check: 229 passing tests; final focused queue tests also pass.
Preprocessor: 128 passing tests, Ruff formatting/lint and Pyright.
Existing analyzer: 308 passing tests with scripted LLM responses; existing UTC
warnings remain. Collector source is unchanged in this pass; its full Go suite
passed at the starting head. The actual HTTP/S3 boundary proof still passes with
40 stored records, one session, 21 messages and a schema-valid scripted report.

Recommendation: after CI passes for the backed-up heads, all three PRs may be
marked ready **for human review**. Keep the release/integration checklist visible.
This review is not a merge or deployment approval. Actual backend ingest/read,
installed CLI/desktop capture, scoped model/identity access, a real correct-user
dashboard report, migration/rollback and original dirty auth/org edit reconciliation
remain outstanding. The collector and parser can be reviewed independently of
client installation; compatible collector support must precede the new client.

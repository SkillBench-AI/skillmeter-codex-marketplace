# Repository capture consent

Codex follows the explicit repository opt-in rule in Claude's
[capture policy](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/30659641c0ecd7aa4f1b41d8624ad0620d9eab93/skillmeter/scripts/lib/telemetry-policy.js).
An allowed GitHub owner makes a repository eligible; it does not enable capture.
The repository choice must be the boolean `true`. Missing or invalid choices
stay off, and explicit opt-out, scope exclusion and global pause block capture.

The existing Codex gate is adapted rather than copying Claude's complete gate:
the latter also depends on its shared policy store and license-validity check.
This change does not alter Codex's credential lifecycle or expiry behavior.

| Boundary | Codex behavior / remaining difference from Claude |
| --- | --- |
| Repository choice | Stored at the checkout's Git root in `.codex/settings.local.json`. Subdirectory commands use the same file. Separate clones and linked worktrees still need separate choices; canonical identity and the shared policy store remain follow-up work. |
| Legacy subdirectory choices | A subdirectory opt-out continues to restrict capture there. A subdirectory opt-in cannot authorize the repository. Nested Git repositories have independent choices. |
| Organization consent | Existing signed-in identity scope and optional narrowing remain. Claude's separate organization authorization record is not adopted here. |
| Revocation and queued data | Repository disable revokes indexed queued events and transcript chunks while preserving cursors and consent journals. Mixed event batches retain permitted repositories. A durable local generation prevents disable/re-enable from restoring revoked payloads. In-flight requests can finish; busy cleanup retries on drain. Unattributed legacy events retain their previous behavior. |
| Disabled transcript intervals | A durable byte-range journal excludes the prefix at first observation and ranges observed while capture is disabled. Repository controls update known active sources; local global controls and shared global `decided_at` changes also record transitions. Staging and baseline resets use the same exclusions. Shared repository and organization transitions remain a gap. |
| Global pause | Either the legacy Codex pause or shared `global.enabled: false` stops new capture and transmission while retaining queued data. Codex reads the shared policy without writing it; `enable --global` clears only the legacy pause and reports any shared blocker. |

This is a capture-gate change, not complete parity with
[Claude's collection contract](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/30659641c0ecd7aa4f1b41d8624ad0620d9eab93/skillmeter/README.md#collection-scope).
Do not present it as retroactive consent isolation or enable a new surface's
uploads on this basis. Work-specific consent and delivery are separate.

Run `node --test plugins/skillmeter/test/repository-consent-boundary.test.js`
for synthetic hook/CLI boundary tests, then `npm run check` for the full suite.
These checks do not prove native hook approval, production receipt or reporting.

## Transcript interval boundary

Hooks observe the current source size before the consent gate using filesystem
metadata only. The first observation excludes existing content. A partial record
crossing an excluded boundary is excluded in full. Only a small projection of the
first session metadata record (identity, source and lineage, without startup
instructions) may cross that prefix; it still passes scope checks and sanitization.
ChatGPT Work transcripts remain excluded from the repository upload path.

Staging preserves permitted records and structured tool payloads, bounds reads to
the observed tail, and applies the same exclusions when rebuilding a server
baseline. Committed prefix verification rejects a rewritten source whose old byte
positions no longer establish authorization. A byte-identical restored prefix can
recover; an uncertain in-place rewrite is retained with `consent-source-rewritten`
and needs investigation rather than historical replay. Missing or corrupt consent
journals never authorize an old prefix.

The boundary is conservative: records written before the first lifecycle
observation, or since the last observation before a settings change, may be
excluded even if the user intended collection. Start a fresh session after opt-in
and verify native startup timing before relying on complete capture. Settings
revision changes also close unobserved intervals. The existing authentication
generation closes sign-out/sign-in intervals even for the same principal; a
normal token refresh preserves the generation and capture continuity. Repository
revocation starts a new capture generation: server resets cannot reconstruct the
pre-revocation prefix. Previously delivered remote data is not deleted.

A shared global decision's `decided_at` change closes the unobserved interval,
including an OFF/ON cycle between Codex hooks. The policy's overall `revision`
does not close intervals: another repository's choice must not discard this
repository's authorized records. Writers that restore an identical global record
leave no transition evidence; those unobserved cycles cannot be detected.

## Shared global policy compatibility

Codex reads schema version 1 from `telemetry-policy.json` under
`SKILLMETER_STATE_DIR`, or `~/.skillbench` (`~/.skillbench-dev` when
`SKILLMETER_ENV=dev`). This matches Claude's
[policy store](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/30659641c0ecd7aa4f1b41d8624ad0620d9eab93/skillmeter/scripts/lib/telemetry-store.js).
Global OFF retains queues, consistent with Claude's
[collection contract](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/30659641c0ecd7aa4f1b41d8624ad0620d9eab93/skillmeter/README.md#collection-scope).
Organization/repository OFF purge requirements in the
[token lifecycle ADR](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/30659641c0ecd7aa4f1b41d8624ad0620d9eab93/docs/adr/001-license-token-lifecycle.md)
remain separate work.

A missing policy preserves Codex's existing explicit local consent rules. Shared
ON does not grant repository consent or clear a legacy pause. Existing malformed,
unreadable or unsupported-version policy pauses capture and delivery without
rewriting it. This conservative read behavior differs from Claude's permissive
normalization and needs agreement before claiming full malformed-policy parity.
Use the shared policy controls to resume a shared pause; Codex's status identifies
that blocker instead of claiming uploads are enabled.

Run `node --test plugins/skillmeter/test/shared-global-policy.test.js` for the
implemented global boundary. Run `node --test compatibility/shared-policy.cjs`
for the remaining repository/organization contract. The latter deliberately
returns nonzero while those gaps remain, is outside the default regression suite,
and must pass before claiming shared-policy parity. Its synthetic cases cover
shared OFF, clones, linked worktrees and revocation of already queued payloads.
Migration precedence between shared and legacy choices is not defined here.


## Queued repository data

The local queue adapter follows Claude's
[payload-removal and cursor-retention contract](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/9c7e33e86f862d59ff20001ff52cd639f637c6b4/skillmeter/scripts/lib/repository-queue.js).
Codex uses a private routing index because its existing event files can contain
multiple repositories. Hook records carry a local generation, removed before
upload. The index stores checkout paths locally; it is not sent to the collector.
Symlink aliases share a generation, while separate checkouts retain separate
consent choices. Every event delivery and retry checks known repository consent.
Missing or corrupt routing fails closed without using the retry budget.
Temporarily unauthorized rows remain queued while permitted rows are delivered.
Acknowledgment atomically retains the held portion at the original path; salvage,
retry exhaustion and age quarantine operate only on the deliverable portion.
Retry counts reset when that portion changes. The existing age limit still
applies when a held record becomes eligible again. Failed local acknowledgment
can repeat an upload, consistent with the queue's existing at-least-once delivery.
Authorization is checked once per directory per attempt, never cached across
attempts. Revocation cleanup skips authorization checks and includes sent and quarantined
event files under the original batch lock. Transcript delivery checks
its captured generation. Repository controls publish the generation and choice
under the registration lock. Lock retries are bounded; persistent contention skips
capture with a diagnostic, and the control command reports that it needs a retry.

Global pause retains payloads. Explicit repository disable during a global pause
still revokes that repository. Direct settings edits enforce the current capture
and delivery gate but do not supply the durable off/on generation recorded by the
CLI. Unknown legacy event ownership, separate organization consent and shared
policy migration are not implemented here. Unattributed legacy batches keep their
existing delivery behavior; this is not a guarantee of retroactive isolation.

Run `node --test plugins/skillmeter/test/queue-revocation.test.js` for mixed-batch,
retry, cursor preservation, in-flight revocation and disable/re-enable checks.

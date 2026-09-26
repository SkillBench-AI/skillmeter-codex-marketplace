# Repository capture consent

Codex implements [ADR 004's shared consent contract](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/main/docs/adr/004-shared-consent.md).
An allowed GitHub owner makes a repository eligible; consent remains separate.
Both organization and repository ON must carry `consent_version: 2` to authorize
capture across clients, clones and worktrees without checkout-local opt-in.
A legacy shared ON keeps the local opt-in requirement. First use with no shared
policy retains the existing local behavior. No local ON is promoted silently.

| Boundary | Codex behavior |
| --- | --- |
| Repository choice | `consent-preview` shows conflicts; `consent-set` writes an explicit shared choice with expected revision and ON acknowledgement. Local controls still write `.codex/settings.local.json`; local OFF or invalid settings block even a shared grant. |
| Subdirectories and identity | A descendant OFF remains restrictive; a descendant ON cannot grant permission. Clones/worktrees use canonical GitHub identity. Nested repositories are independent. |
| Organization | Licensed identity scope and optional narrowing still apply. The repository command cannot grant or upgrade organization authorization. |
| Queues | Explicit OFF revokes known payloads, including while paused. Missing choices hold. Changed positive decisions or acknowledgement versions hold old stamped payloads. Unrelated repository edits preserve authorization. In-flight requests may finish; busy cleanup is deferred. Legacy unattributed data retains its behavior. |
| Global pause | Either legacy Codex pause or shared global OFF blocks capture and delivery while retaining queues. `enable --global` clears only the legacy pause. |
| Invalid or disappeared policy | The runtime and controls share a strict reader and durable client observation marker. Invalid policy or marker failures hold capture/delivery without normalizing or rewriting policy. |

Authentication lifecycle and expiry behavior are unchanged. Organization-control
ownership and final acknowledgement wording need separate review. ChatGPT Work
transcript delivery remains unsupported; shared grants do not bypass that
capability boundary.

Run `node --test plugins/skillmeter/test/shared-consent-gates.test.js` for the
shared-grant boundary tests, then `npm run check` for the full suite. Synthetic
checks do not prove installed hook trust, production receipt or reporting.

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

## Shared policy compatibility

Codex reads schema version 1 from `telemetry-policy.json` under
`SKILLMETER_STATE_DIR`, or `~/.skillbench` (`~/.skillbench-dev` when
`SKILLMETER_ENV=dev`). This matches Claude's
[policy store](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/30659641c0ecd7aa4f1b41d8624ad0620d9eab93/skillmeter/scripts/lib/telemetry-store.js).
Global OFF retains queues, consistent with Claude's
[collection contract](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/30659641c0ecd7aa4f1b41d8624ad0620d9eab93/skillmeter/README.md#collection-scope).
Organization/repository OFF purges indexed payloads while retaining privacy
cursors, following the
[token lifecycle ADR](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/30659641c0ecd7aa4f1b41d8624ad0620d9eab93/docs/adr/001-license-token-lifecycle.md);
legacy unattributed event rows retain their previous behavior.

A policy that has never been observed preserves Codex's existing explicit local
consent rules. Removing a previously observed shared policy holds data and
blocks capture until it is readable again. Acknowledged shared ON can replace
local opt-in, but cannot clear local restrictions or a legacy pause. Both organization and repository acknowledgement
versions participate in the consent boundary. Existing malformed,
unreadable or unsupported-version policy pauses capture and delivery without
rewriting it. This conservative reader blocks invalid state; Claude's referenced reader
normalizes it instead.
Use the shared policy controls to resume a shared pause; Codex's status identifies
that blocker instead of claiming uploads are enabled.

Run the shared boundary tests:

```sh
node --test plugins/skillmeter/test/consent/shared-global-policy.test.js plugins/skillmeter/test/consent/shared-repository-policy.test.js
```

The former standalone audit, `node --test compatibility/shared-policy.cjs`, now
runs the same repository fixtures included in the default CI suite.

Canonical identity parsing follows Claude's pinned `repo-scope.js`: matching
origin wins, otherwise one unambiguous matching repository is required. SSH
aliases and Git `insteadOf` rewrites are supported. Codex retains its existing
stricter rejection of empty/unreadable `commondir`; long-lived processes reload
remote-resolution configuration so a changed alias is not cached as permission.

Only an observed OFF deletes queued data. A changed positive decision may be an
unobserved OFF/ON cycle or just reaffirmation: older stamped payloads are held,
not uploaded or deleted. Capture starts a new consent interval; resets cannot
reconstruct the uncertain prefix. Unrelated repository decisions do not affect
this queue. Requests already in flight can finish. Background drains and blocked
hooks reconcile revocations, including quarantined and active event data.

`consent-set` writes through the shared store lock and expected revision; it
preserves local settings and never authorizes an organization. Local ON is not
promoted automatically. See [ADR 004](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/main/docs/adr/004-shared-consent.md).

## Queued repository data

The local queue adapter follows Claude's
[payload-removal and cursor-retention contract](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/30659641c0ecd7aa4f1b41d8624ad0620d9eab93/skillmeter/scripts/lib/repository-queue.js).
Codex uses a private routing index because its existing event files can contain
multiple repositories. Hook records carry a local generation, removed before
upload. The index stores checkout paths locally; it is not sent to the collector.
Symlink aliases share a local generation. Separate checkouts retain local
restrictions but share acknowledged canonical repository consent. Every event delivery and retry checks known repository consent.
Missing or corrupt routing fails closed without using the retry budget.
Temporarily unauthorized rows remain queued while permitted rows are delivered.
Acknowledgment atomically retains the held portion at the original path; salvage,
retry exhaustion and age quarantine operate only on the deliverable portion.
Retry counts reset when that portion changes. The 14-day retry age still applies
when a held record becomes eligible again. Sealed event batches are removed
after 30 days from sealing, including held rows. Cleanup runs before the global
pause check, uses the batch lock, and does not extend retention when a mixed
batch is rewritten. Transcript chunks and legacy snapshots remain excluded from
automatic expiration; their retention contract must be settled separately.
Failed local acknowledgment
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
CLI. Unknown legacy event ownership and organization controls remain separate work. Unattributed legacy batches keep their
existing delivery behavior; this is not a guarantee of retroactive isolation.

Run `node --test plugins/skillmeter/test/consent/queue-revocation.test.js` for mixed-batch,
retry, cursor preservation, in-flight revocation and disable/re-enable checks.

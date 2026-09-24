# Shared consent native canary

Prepare a local candidate to check Codex's restrictive shared-policy reader
against Claude's actual policy writer. This does not adopt shared positive grants
or migration policy. Review the proposed amendment in Claude's
`docs/adr/001-license-token-lifecycle.md` before validating those behaviors.

## Prepare and rehearse

From the Codex repository, using a reviewed Claude checkout:

```sh
node integration/shared-consent/prepare.cjs /absolute/new/canary /absolute/claude-checkout
node --test integration/shared-consent/harness.test.js
node integration/shared-consent/rehearse.cjs /absolute/claude-checkout
```

Preparation exports committed plugin files at both checkouts' HEADs and records
their revisions in `config.json`. Uncommitted source changes are not included.
The wrapper hashes are recorded separately. The destination must not exist.
It contains synthetic repositories A, an A clone, a linked A worktree and B;
isolated HOME, policy, credentials and plugin data; and a fake collector returning
503 initially. No real credentials, native sessions or installed-plugin files
are copied. It starts disabled and installs no hooks until explicitly armed.

The six automated harness tests use a Claude-store spy to verify delegation and
isolation. The rehearsal uses the supplied committed Claude store, synthetic
hook subprocesses and intercepted delivery. Neither is native evidence.

## Native preflight, coordinated with the assistant

1. Confirm the candidate revisions and accepted behavior to test. Run
   `node /absolute/new/canary/run.cjs arm`. This installs hooks only in the four
   synthetic projects for a 24-hour window. It does not trust them.
2. Open `a` as the desktop task's **primary project**, not an attached folder.
   Review the project hooks whose commands contain this canary's `run.cjs` and
   whose messages start `Shared consent canary`. Installed SkillMeter hooks are
   separate and do not establish candidate discovery. If desktop has no review
   prompt, use the CLI in that same directory to review `/hooks`, then reopen the
   desktop task. Do not proceed until the candidate hooks are visible/trusted.
3. Send `SHARED-A-PREFLIGHT. Reply PREFLIGHT only. Do not use tools or change
   telemetry settings.` Tell the original task which surface you used.
4. The assistant verifies the exact project/session and binds it with
   `node run.cjs bind a SESSION_ID TRANSCRIPT_PATH`. Binding validates the first
   `session_meta` identity and working directory. It never selects the first
   callback automatically. Repeat the preflight; confirm candidate callbacks
   completed and no events/transcripts were captured before consent.

Repeat preflight/binding for B and for the clone/worktree when their turn comes.
The assistant locates the selected session locally; do not paste/upload logs.
All source content must be synthetic. Never run this against an ordinary task.

## Native acceptance sequence

The following controls affect only the isolated candidate. `shared` invokes the
pinned Claude `telemetry-store.js` API; it does not drive Claude's UI or establish
Claude native-hook acceptance. Repository changes use its expected-revision check.
`local` invokes the pinned Codex telemetry CLI.

| Step | Assistant action | Native action / expected result |
| --- | --- | --- |
| Shared ON alone | `shared org on`, `shared repo a on`, `shared repo b on` | Prompt in A/clone/worktree without local opt-in: no capture. |
| Eligible capture | `local a enable`, then `local b enable`; receiver stays 503 | In each bound task: `SHARED-A-ONE` or `SHARED-B-ONE`, read `source.csv` with a local tool and report total minutes (60). No settings, network, connectors or subagents. Verify both prompts and linked tool calls/results in queued records. |
| Cross-checkout revoke | Record queue/cursor hashes; `shared repo clone off` | Prompt in A and enabled clone/worktree. All A payloads removed after reconciliation, no new A capture, privacy cursors retained; B bytes unchanged. |
| B delivery | `receiver 200` | Native B no-tool follow-up triggers Stop: B arrives at the intercepted receiver; no A records or private `_queue` fields. |
| Pause | `receiver 503`, capture fresh B; `shared global off` | `SHARED-B-PAUSED` prompt: no capture/delivery; queued bytes retained. |
| Resume | `shared global on`, `receiver 200` | `SHARED-B-RESUMED` prompt: fresh records and authorized backlog arrive; paused prompt/response absent. |
| A re-enable | `shared repo a on` | Fresh A prompt with one local tool call; no revoked prefix in queued/received transcripts, including any reset. |
| Unknown state | Assistant replaces only the isolated policy with malformed JSON or temporarily removes it, then restores exact bytes | Prompt during hold is excluded; policy is not overwritten, queues retained, status reports the blocker. |

Commands above are arguments to `node /absolute/new/canary/run.cjs`.
Do not count manual drains/replayed hook subprocesses as native dispatch. Older
payloads after an ambiguous positive timestamp change stay held; that contract
still needs engineering agreement. Concurrent/in-flight races and expiry remain
separate deterministic acceptance cases unless explicitly reproduced natively.

## Evidence and cleanup

Record exact revisions, native surface, hook trust/discovery, selected-session
metadata, prompt markers, tool call/result counts and identifiers, queue/cursor
hashes before/after transitions, and received record counts. Distinguish absent,
held, purged and delivered records. Counts alone do not prove complete capture.
Compare selected source records to sanitized received records; retain uncertainty
for unmatched tools rather than declaring success.

`callbacks.jsonl` contains content-free callback outcomes. Queues, bindings and
intercepted bodies stay private under the canary directory; never commit them.
Publish only reviewed counts, digests, source labels and outcome codes. An
intercepted 200 is not collector acceptance or dashboard evidence.

Run `node run.cjs retire` to disable callbacks and remove only unchanged generated
hook files. Verify the detached drain lock has cleared before archiving evidence.
The wrapper and allowed worker both stop at expiration/disabled checks; a request
already in progress can finish. Controls after expiry require a newly prepared run.

The network/process guard is cooperative test interception, not an OS security
sandbox. Only the pinned drain worker may spawn; only the fake collector origin
is intercepted. This harness changes no real shared settings, authentication,
installed plugin, schedule, release or production service.

# Shared consent native canary

Prepare an isolated Codex candidate against a pinned Claude policy writer.
Consent behavior follows [ADR 004](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/main/docs/adr/004-shared-consent.md).
The default rehearsal checks legacy choices and restrictions. A separate mode
checks acknowledged shared grants when that implementation is in the candidate.

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

The automated harness tests use a Claude-store spy to verify delegation and
isolation. The rehearsal uses the supplied committed Claude store, synthetic
hook subprocesses and intercepted delivery. Neither is native evidence.
The rehearsal waits for detached workers and pending trigger completion between
transitions. The serial rehearsal does not establish concurrent-hook delivery
liveness. Failed rehearsals retire the harness and retain synthetic artifacts for
inspection instead of deleting the evidence.

## Acknowledged shared-grant rehearsal

Use a composed Codex checkout containing the shared store, `consent-preview`,
`consent-set`, and the acknowledged capture/delivery gate. These commands export
that checkout's committed HEAD, so commit the composition before running:

```sh
node integration/shared-consent/rehearse.cjs /absolute/claude-checkout legacy
node integration/shared-consent/rehearse.cjs /absolute/claude-checkout acknowledged
```

The acknowledged mode seeds **synthetic version-2 organization authorization**
inside the isolated fixture. This is not an organization control or evidence of
Claude's acknowledgement flow. Repository grants use the actual Codex command,
with an explicit canonical repository, preview revision and scope acknowledgement.
Claude's actual writer supplies revocation and global pause/resume. Checks cover
capture without local ON in A/B/clone/worktree, local OFF restrictions, stale
confirmation after Claude revocation, re-enablement, paused/invalid transcript
exclusion and unaffected B delivery with a linked tool pair.

For a coordinated native candidate, `node run.cjs consent LABEL preview` delegates
to Codex's JSON preview. `consent LABEL on|off` passes explicit confirmation flags
to `consent-set`; the wrapper never infers acknowledgement or upgrades organization
consent. For example, after reviewing the preview and organization authorization:

```sh
node run.cjs consent a on --repository github.com/acme/widgets --revision 7 --acknowledge-machine-scope
```

Use the actual reviewed revision, not the example number. The native sequence
below covers **legacy** shared ON. Do not apply its no-local-capture expectation
to acknowledged grants. A narrow native follow-up can use one bound A task:
verify capture with acknowledged consent and no local ON, then local OFF exclusion,
then removal of that synthetic local restriction and fresh capture. Compare every
turn with the verifier; synthetic rehearsal results cannot replace native dispatch.

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
| Clone/worktree capture baseline | `local clone enable`, `local worktree enable`; receiver stays 503 | In each bound task, read `source.csv` with `SHARED-CLONE-ONE` / `SHARED-WORKTREE-ONE`. Verify each checkout actually captures before testing shared revocation; silence without this baseline is inconclusive. |
| Cross-checkout revoke | Record queue/cursor hashes; `shared repo clone off` | Prompt in A and enabled clone/worktree. All A payloads removed after reconciliation, no new A capture, privacy cursors retained; B bytes unchanged. |
| B delivery | `receiver 200` | Native B no-tool follow-up triggers Stop: B arrives at the intercepted receiver; no A records or private `_queue` fields. |
| Pause | `receiver 503`, capture fresh B; `shared global off` | `SHARED-B-PAUSED` prompt: no capture/delivery; queued bytes retained. |
| Resume | `shared global on`, `receiver 200` | `SHARED-B-RESUMED` prompt: fresh records and authorized backlog arrive; paused prompt/response absent. |
| A re-enable | `shared repo a on` | Fresh A prompt with one local tool call; no revoked prefix in queued/received transcripts, including any reset. |
| Unknown state | Assistant replaces only the isolated policy with malformed JSON or temporarily removes it, then restores exact bytes | Prompt during hold is excluded; policy is not overwritten, queues retained, status reports the blocker. |

Commands above are arguments to `node /absolute/new/canary/run.cjs`.
Before changing policy/receiver state or measuring settled queues, the assistant
checks both drain lock formats and any pending request/completion markers. A pending capture hint is not
proof of delivery. Record any required follow-up hook separately.
Do not count manual drains/replayed hook subprocesses as native dispatch. Older
payloads after an ambiguous positive timestamp change stay held under ADR 004. Concurrent/in-flight races and expiry remain
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
hook files. Verify the detached drain worker lock has cleared before archiving evidence.
The wrapper and allowed worker both stop at expiration/disabled checks; a request
already in progress can finish. Controls after expiry require a newly prepared run.

The network/process guard is cooperative test interception, not an OS security
sandbox. Only the pinned drain worker may spawn; only the fake collector origin
is intercepted. This harness changes no real shared settings, authentication,
installed plugin, schedule, release or production service.

## Automate turn verification

Once native sessions are explicitly bound, the assistant can perform the controls
and source comparisons without asking the operator to find logs. Before each
prompt, record a private snapshot with the verifier from this checkout:

```sh
node integration/shared-consent/verify-turn.cjs begin /absolute/canary b SHARED-B-BACKLOG queued 1
# Submit the matching prompt in the selected desktop task and wait for completion.
node integration/shared-consent/verify-turn.cjs verify /absolute/canary SHARED-B-BACKLOG
```

The last argument is the expected number of linked tool call/result pairs. Use
`queued` for capture while the intercepted receiver returns503, `delivered` when
it returns200, or `excluded` for a paused turn. Use a new marker for every turn.
Receipts under `verification/` are private and must stay outside Git. `begin`
refuses reused snapshots, already-used markers, inactive candidates and active
drains. `verify` may inspect a completed run after retirement. It fails with a
bounded diagnostic instead of printing transcript content or credentials.

The verifier requires a native user message, completion, matching bound
UserPromptSubmit/Stop callbacks and the expected linked tool pairs. Captured turns
must match the pinned sanitizer's output record by record. Excluded turns must
leave queued payload bytes, attempts and received files unchanged. A successful
turn receipt covers only that turn: the operator still checks baseline backlog
preservation, revoked-prefix absence, session isolation and collector semantics
as described above. It is not a whole-suite or production pass.

For the final four steps, the assistant owns this sequence:

1. After B delivery, set receiver503. Snapshot B BACKLOG as `queued 1`, submit the
   CSV-read prompt, verify it, and retain backlog hashes.
2. Set shared global OFF. Snapshot B PAUSED as `excluded 0`, submit its no-tool
   prompt and verify byte retention and no attempts.
3. Set shared global ON and receiver200. Snapshot B RESUMED as `delivered 0`,
   submit its no-tool prompt and verify. Compare delivered backlog with step1 and
   exclude all source records from the paused interval, including its response.
4. Set shared repository A ON. Snapshot A REENABLED as `delivered 1`, submit its
   CSV-read prompt and verify. Check that old A payloads and the revoked interval
   never return, including under a reset. Retire after the drain settles.

Prompt submission is a separate driver capability. A driver must use the actual
native composer and pass a no-tool qualification probe before automating the
suite. Task-messaging APIs can insert a tool-output record and invoke Stop without
UserPromptSubmit; that is not an equivalent native user turn. The regression
fixture explicitly rejects this shape. If desktop UI control is unavailable or
disallowed, retain manual prompt submission and automate the controls/verifier.
Never bypass hook trust, use direct hook replay as native evidence, or silently
substitute CLI execution for desktop validation. Do not run scheduled canaries.

## Overlapping final-hook check

Use a candidate containing the process-owned final-drain repair. After native
binding, consent and one enabled warm-up turn, wait for delivery to settle:

```sh
node /absolute/canary/overlap.cjs arm /absolute/canary a
```

Within 15 minutes, send this one no-tool prompt in the bound desktop task:

> SHARED-OVERLAP. This is a synthetic local telemetry test. Reply OVERLAP-DONE only. Do not use tools or change telemetry settings.

The intercepted receiver holds the next transcript upload until it observes that
same task's completed Stop callback and a newer durable drain trigger. It checks
that the original worker retains its lock throughout. The hold respects the
request's abort signal and stops after 25 seconds; a slow turn fails the check
rather than extending the production timeout. No further prompt or manual drain
may be used to complete this test.

After the worker settles, run:

```sh
node /absolute/canary/overlap.cjs verify /absolute/canary
```

The verifier requires the held upload, overlapping Stop, unchanged owner,
completed trigger, exactly one Stop, complete sanitized native turn and no
repeated transcript sequence or content-record transport IDs. If the first
upload began only after Stop, the result is inconclusive and cannot pass.
Receipts are private, under `verification/`; retire after inspection. Use a fresh
prepared run after failure. This is native dispatch into an intercepted receiver,
not production collector acceptance.

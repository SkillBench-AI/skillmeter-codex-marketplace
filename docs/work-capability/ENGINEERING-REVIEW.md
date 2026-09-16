# Local ChatGPT Work: engineering review packet

Updated September 16, 2026 after the repaired native app-restart canary. Ready for scoped engineering review; production Work delivery remains disabled. The user deferred a full Mac restart, and the temporary plugin and queued payloads have been removed. This packet replaces the earlier review status; dated evidence remains historical.

## Scope and current result

Extend the existing Codex plugin with explicit local Work task consent, reusing its sanitizer, durable queue and shared preprocessor. No separate production plugin or cloud migration is proposed. Work staging is isolated from the production upload queue. Task consent excludes prior content and binds task/source/cwd/account/device/policy; the current experimental grant lasts24 hours. Shipping consent UX and duration still need agreement.

Current plugin source: `274899d93c003354d2a431043315436f43abdef4`, branch `codex/work-capability-20260915`, based on Codex repair `8cb4a4d5fd763e4c4ff0681b9071ac864159cdb0`. Later commits contain evidence/checkpoints. Pipeline source: `3abe812f98e625ff17e5719c816edfa31275ddcf`, branch `codex/work-normalization-20260915`, based on pipeline repair `fd5a75814e1622949d13eb54452251274aef5ac4`. Both isolated Work branches are local and stacked. No remote push, PR update, deployment or production send occurred in this preparation.

The repaired native canary covered an initial turn and a follow-up after quitting/reopening the app. All57 native callbacks succeeded. After collecting the late tail separately,52 chunks normalized into28 messages, including both user prompts and20 unique outer tool call/result pairs exactly matching the consented source. Source identity and setup exclusion held; no malformed, unsupported or incomplete-tool diagnostics. Totals60/30 and unchanged memo60 were verified. Native callbacks and manual reconciliation are recorded separately in [app-restart evidence](native-canary/app-restart-evidence.json).

The earlier canary found that replacing a transcript file on resume revoked capture even when prior content was identical. Source274899d now uses the existing cursor's prefix proof and snapshot rules while preserving the current consent journal. Changed/truncated content, identity/consent changes and old-grant cursors remain denied. The repair also prevents same-file truncation from silently resetting consent. The latest live app restart retained the file identity, so replacement continuity is verified by deterministic tests, not by this live run. See [repair details](native-canary/RESUME-REPAIR.md).

| Capability | Evidence / remaining gate |
| --- | --- |
| Selected local Work capture, sanitization and normalization | Native two-turn app-restart canary passed on274899d |
| App quit/reopen with unchanged file | Passed; consent persisted without renewal |
| Exact-prefix file replacement | Deterministic tests and fresh handler processes passed; not exercised in latest native canary |
| Full machine restart | Deferred by user, not a passing or failing result |
| Full production plugin manifest and consent UI | Guarded test package verified; shipping manifest/UX still needs validation |
| Analysis/report assembly |333 analyzer tests passed with scripted models; general Work scoring remains unvalidated |
| Authenticated Work upload and correct-user dashboard | Work sender not implemented; no live production result |
| Cloud Work and ordinary chat | Unsupported in this implementation |

Cleanup is verified:52pending payloads purged, grant disabled, native control cleared/expired, only the temporary plugin uninstalled/cache removed. Normal SkillMeter, shared credentials/policy and global telemetry ON are preserved. Original source transcripts were not deleted or copied into this packet. See [cleanup evidence](native-canary/restart-deferred-cleanup.json).

## What changed and where to review

Plugin product delta from8cb4a4d: `plugins/skillmeter/scripts/lib/work-local.js`, `work-runtime.js`, `session-metadata.js`, `transcript-delta.js`, `queue-retention.js`, `scripts/logger.js`, `scripts/work-local.js`, and `test/work-local.test.js` / `work-runtime.test.js`. Start with the Work adapter and its tests. The resume repair itself changes only `work-local.js` plus tests and fixture/docs. Earlier Work changes made identity reads non-mutating and retained existing grants/queues through token expiry; new grants still need an unexpired credential. Logout, terminal purge and changed principal/device/tenant revoke. No competing shared-auth writer or Work sender was introduced.

Pipeline delta fromfd5a758 includes five preprocessor modules (`model`, `codex`, `preprocess`, `structured`, `flatten`) and `test_work_identity.py`, plus analyzer `job`, `pipeline/generator`, `session_analysis`, `analysis/runner`, `analysis/parse` and `analysis/analyze`, tests for Work compatibility/job/worker, and docs. Agent/surface/originator survive normalization and internal analysis. All-filtered sessions produce the existing insufficient-activity skip with no model call, report write or ingest; eligible companion input still runs. Prompts and public report schema are unchanged. See that checkout's `docs/work-analyzer-repair.md` and `docs/work-analyzer-compatibility.md`.

The experimental wrappers, fixtures and long checkpoint history under this directory are review evidence, not proposed shipping UI. Review the product delta separately from the underlying Codex repair and #37/#38 reconciliation.

## Validation

Latest plugin `npm run check`:466 Node tests,55 offline lifecycle scenarios, version/manifest checks passed. Five newly added resume regressions failed before repair and pass after. Tests cover repeated replacements, partial trailing results, corrupted/truncated history, pre-consent and paused exclusions, retired-body protection, identity changes and current-grant continuity. Fresh SessionStart/Stop processes run against synthetic state with network blocked. The queue-to-preprocessor fixture splits a tool call/result across replacement and retains one pair without duplicates. Both expiry-retention and read-only credential probes pass. These focused results overlap with full-suite counts.

Pipeline evidence remains the earlier333 analyzer tests at3abe812f, with18 existing datetime warnings. The earlier lint comparison had zero new findings, but legacy lint is not fully clean. Pipeline source was not changed or its full suite rerun during this canary cleanup. Native canary packaging matched all101 candidate files. These results do not establish production report accuracy or long-session performance.

## Decisions before the next product change

| Decision | Proposed default | Response needed |
| --- | --- | --- |
| Work consent UX and lifetime | Explicit task selection/revocation, future bytes only, visible capture status | Seungho/Homin: agree the shipping entry point and grant duration/renewal; the24-hour experimental limit is not adopted product policy |
| Common credentials | Consume the INF-177 / INF-200 contract; no Work-specific auth identity or writer | Resolve #37/#38 lock/generation/device/broker rules and cross-client tests before wiring delivery |
| First report trial | Existing approved candidate environment and explicit account/tenant | Identify the environment and how authenticated identity maps to the intended dashboard user; no secrets in the review packet |
| Work analysis coverage | Keep partial/unsupported outcomes visible | Confirm acceptable sample/eligibility and rubric, plus the existing corruption-treatment question, before claiming general Work scoring |

The earlier issue and PR context was inspected before this packet update, not re-queried now. Use [INF-177](https://linear.app/skillbench/issue/INF-177) for Work scope/shared-credential discussion and [PR148](https://github.com/SkillBench-AI/skillbench-pipelines/pull/148#issuecomment-5673631192) for the existing pipeline repair/comparison review. INF-210's correct-user live-report outcome remains unproven. TEL-7's transfer to INF-177 was not a validation pass. Previously observed PR37/148 were draft and PR38 open/non-draft; no current remote status is asserted here.

## Next sequence

Engineering can review these local source/evidence changes now; a Mac reboot is not a prerequisite for review or independent source work. After agreeing consent and credentials, implement the shipping selection/status flow and gated authenticated Work delivery using existing transport. Run the approved-object comparison and preserve valid Claude/mixed-agent report behavior. Then trace one explicitly approved real Work session through stored sanitized chunks, shared normalization, an actual analyzer run and the existing dashboard for the intended user. Keep production enablement separate from that preparation.

For the deferred restart test, prepare a fresh temporary package/task and fresh consent when convenient. Verify its initial capture, record the boot identity and committed prefix, restart the Mac, and continue the same task within the valid grant. Inspect native callbacks before manual reconciliation, compare latest-baseline normalized records and exact tool links, then disable/purge/uninstall. Do not re-enable the cleaned-up grant or reconstruct its purged queue. A machine reboot may retain file identity; report that accurately rather than treating it as live replacement-path proof.

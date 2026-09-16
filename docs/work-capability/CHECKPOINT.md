# Work branches backed up remotely, September 16, 2026

User requested remote backup. Successfully pushed origin/codex/work-capability-20260915 (initial backup2655398; subsequent documentation commit records publication) and origin/codex/work-normalization-20260915 at3abe812f98e625ff17e5719c816edfa31275ddcf. Upstream tracking is set. Review packet and unsent draft now include branch links. Plugin implementation remains274899d. No force push, tag, PR creation/update, merge, release, deployment or message to engineering.

Verified remote mains remain plugin13b4648761aae7e9ebb20477276c13a416460173 and pipelinef3d6710aa1ce4ca26fcb40c621ebf8bf618f34e1. Neither Work branch existed remotely before this operation. Defined CI/deploy/release workflows do not run on these feature-branch pushes: CI uses PR/main; pipeline deployments use main/manual; plugin release uses version tags. A targeted credential-pattern scan of132new plugin-history blobs and21pipeline-history blobs found no flags. This scan is not a general security audit. Only committed source/tests/docs/content-free canary evidence were pushed; protected credentials and runtime transcripts/queues are outside Git.

Branch links: https://github.com/SkillBench-AI/skillmeter-codex-marketplace/tree/codex/work-capability-20260915 and https://github.com/SkillBench-AI/skillbench-pipelines/tree/codex/work-normalization-20260915. These are stacked review/backup branches, not independently merge-ready main changes. Existing repair PRs were not changed. Machine restart remains deferred; temporary canary is removed and grant disabled. Next is engineering review/contract agreement as described in ENGINEERING-REVIEW.md. No further canary setup or delivery is enabled by publishing branches.

Earlier checkpoints follow.

# Machine restart deferred; review packet ready, September 16, 2026

User deferred a full Mac restart as disruptive and asked to progress. This is not a failed test or a waiver of release validation. App-only restart passed; replacement continuity is deterministic-test evidence, not yet live replacement proof. Cleanup completed: disabled the current grant, purged52payloads, cleared/expired the native control and uninstalled only skillmeter-work-canary@personal. Installed cache gone, no pending purge/production queue, normal SkillMeter and shared credentials/policy unchanged, global telemetry ON. Evidence: native-canary/restart-deferred-cleanup.json.

Updated ENGINEERING-REVIEW.md and the unsent ENGINEERING-MESSAGE-DRAFT.md with current source274899d/pipeline3abe812f,466Node/55lifecycle checks and native57callback/28message/2prompt/20tool-pair evidence. Removed stale expiry/identity-gap claims and corrected the pipeline delta to include analyzer changes. Remote issue/PR states are explicitly historical, not freshly checked. Both Work branches remain local and stacked. No source implementation, remote push, PR update or message sent during this step.

NEXT: engineering review of the bounded Work delta and agreement on shipping consent UX/lifetime, common credential contract, approved environment/account/dashboard mapping and analyzer suitability. Those decisions gate authenticated Work delivery; a full Mac reboot does not block review or independent source work. Before any later machine-restart canary, prepare a fresh package/task and fresh consent, verify baseline, then restart and compare native capture/latest snapshot/source links before cleanup. Do not resume the disabled grant or reconstruct purged data. No manual canary action is currently pending for the user. Production delivery/analyzer/dashboard completion remains unproven.

Earlier checkpoints follow.

# Repaired canary app restart passed, September 16, 2026

Selected task01a0a88f-ea78-7d63-8d29-e6964393ce9d survived the user-reported app-only quit/reopen. Eleven new native callbacks (SessionStart,UserPromptSubmit,4PreToolUse,4PostToolUse,Stop;10staged/1unchanged) all passed. Native SessionStart staged; original consent/expiry remained unchanged. Total57callbacks. The source file identity was unchanged, so this verifies app restart continuity but does NOT independently exercise the repaired replacement path live. Prior committed prefix matches. Before reconciliation:51chunks,548late bytes; after:52chunks,zero pending bytes,baseline1/sequence52. Normalization preserves28messages/2users and20unique outer tool pairs exactly matching source, Work identity/setup exclusion, zero malformed/unsupported/incomplete-tool diagnostics. Follow-up30, memo60 unchanged. Credentials/policy unchanged during verification, production queue empty. Evidence: native-canary/app-restart-evidence.json.

NEXT USER STEP: restart the Mac normally, reopen the app and continue the SAME selected task. Calculate total excluding Read notes using previous values; read /Users/juhokim/Code/skillbench-all/reports/chatgpt-work-native-resume-canary-20260916/workspace/memo.md to confirm original total; report both, change no files/settings. Expected50/60. Return Mac restart canary done. Verify machine boot-session hash differs from app-restart-evidence, inspect callbacks after57 and capture status BEFORE reconciliation, verify prior sequence52 prefix/consent and file-identity change (do not claim replacement if unchanged). Normalize pendingFiles/latest-baseline and compare all3prompts/tool links against consented source tail. Then disable/purge/clear control and uninstall only temporary skillmeter-work-canary@personal. Preserve normal SkillMeter/global telemetry/shared auth/policy. No historical replay or production send.

Candidate274899d installed0.1.0+codex.20260916045017; pipeline3abe812f. Grant/control unchanged; effective control expiry September17 13:50KST. Cleanup pending Mac test. Boot-session hash saved as content-free comparison evidence. Guarded native packaging only; production delivery/analyzer/dashboard remain unverified.

Earlier checkpoints follow.

# Repaired canary first turn passed, September 16, 2026

Selected fresh task01a0a88f-ea78-7d63-8d29-e6964393ce9d produced memo60. All46 native callbacks passed (1UserPromptSubmit,22PreToolUse,22PostToolUse,1Stop), with40 staged and6 unchanged outcomes and matching native environment. Before manual reconciliation:40 pending chunks and471 late bytes. Reconciliation added1chunk;41 chunks, zero pending bytes, current grant enabled. Pipeline normalization yielded20messages/1user and16unique outer tool call/result pairs exactly matching selected raw source IDs; no malformed/unsupported/incomplete-tool diagnostics, Work identity retained, setup excluded. Credentials/policy unchanged during verification; no production queue/send. See native-canary/resume-first-prompt-evidence.json for memo/file-identity hashes and counts.

NEXT USER STEP: quit the desktop app completely (Cmd+Q), reopen it, and continue the SAME selected task. Do not restart the Mac yet. Prompt: use the prior activity values to calculate total excluding Prepare slides; read /Users/juhokim/Code/skillbench-all/reports/chatgpt-work-native-resume-canary-20260916/workspace/memo.md, confirm it still holds original total, report both and change no files/settings. Expected30/60. Return App restart canary done here. Before reconciliation, inspect callbacks added after46 and capture status, file-identity change and queue snapshot baseline. Normalize pendingFiles/latest-baseline and compare both source prompts and tool IDs. Only after passing app restart should the user test Mac restart, separately, with expected50/60 (excluding Read notes). Do not silently renew consent. Control expires September17 13:50KST. Cleanup remains pending both restart tests.

Candidate274899d, installed0.1.0+codex.20260916045017; pipeline3abe812f. Guarded native capture only, not unmodified production packaging or dashboard completion. No source, remote PR, auth configuration or production change.

Earlier checkpoints follow.

# Repaired restart canary bound, September 16, 2026

Fresh setup task01a0a88f-ea78-7d63-8d29-e6964393ce9d is verified as local Work (source=vscode, originator=codex_work_desktop, actual cwd=/Users/juhokim/Code/skillbench-all). Existing SkillMeter token is now valid. Installed repaired candidate274899d has an enabled future-byte grant; the167406-byte setup is excluded, queue empty. Shared credentials/policy were unchanged by binding. The exact task/cwd/transcript are bound in /Users/juhokim/.codex/work-native-resume-canary-20260916/config.json, with control expiry September17 13:50KST. Native dispatch evidence still awaits the actual first test. See native-canary/resume-selection-evidence.json.

NEXT USER STEP: in that SAME fresh setup task, read /Users/juhokim/Code/skillbench-all/reports/chatgpt-work-native-resume-canary-20260916/workspace/source.csv, calculate total and write memo.md in the same folder. Then return Restart first prompt done here. Do not restart yet. Inspect selected native callbacks/queue before reconciliation, then normalize pendingFiles/latest-baseline and compare source/tool IDs. Expected60. Verify first capture before the app-only restart test (exclude Prepare slides ->30 with memo60), and verify that before Mac restart test (exclude Read notes ->50 with memo60). Do not reuse earlier canary tasks or reconstruct their purged queues. Cleanup remains pending this new canary. Delivery is disabled; no production/PR changes.

Earlier checkpoints follow.

# Repaired restart canary prepared, September 16, 2026

Installed SkillMeter Work Canary 0.1.0+codex.20260916045017 with unchanged candidate274899d;101 files verified, seven installed unselected checks and four wrapper tests pass. Control /Users/juhokim/.codex/work-native-resume-canary-20260916/config.json expires 2026-09-17T13:50:17.459000+09:00; no task selected, capture off, delivery disabled. Normal SkillMeter/shared credentials/policy unchanged. Existing token is expired: verify normal startup refresh after user setup and require valid auth before enabling a fresh grant. Do not bypass or change shared auth/org scope.

NEXT: user creates a fresh local Work task, selects/reviews the canary's seven hooks, sends only the setup prompt in native-canary/RESTART-CANARY.md and returns Restart preflight done. Locate that fresh task, confirm Work metadata/cwd and auth, enable future-byte consent and bind new control. Then test first capture, app-only restart, and Mac restart separately with assistant verification between each. Use pendingFiles/latest-baseline normalization. Old canary remains disabled; new temporary plugin cleanup is pending the new test. No source code/production/PR change in this preparation.

Earlier checkpoints follow.

# Resume repair source complete, September 16, 2026

Source commit274899d93c003354d2a431043315436f43abdef4 on codex/work-capability-20260915 repairs the prefix-preserving file-replacement failure found after the native app/Mac restart. The Work adapter keeps its original consent journal and permits replacement only with a committed cursor from the current grant; the existing queue verifies prefix integrity and selects the latest snapshot baseline. Changed/truncated history, altered identity/consent and symlinks are denied. Repeated resume preserves messages/tool links without duplicates, does not renew consent, and cannot restore excluded or retired content. No shared queue/authentication/Claude/pipeline implementation changed.

Validation: five failing regressions before repair; final npm run check passes466 Node tests,55 lifecycle scenarios, version and manifest checks. Actual SessionStart/Stop handlers pass in fresh synthetic processes with network blocked and an established sign-in. The replacement-crossing queue-to-preprocessor bridge preserves three messages/one outer tool pair and Work identity with no actionable/incomplete diagnostics. Both earlier review probes pass. See native-canary/RESUME-REPAIR.md and outside-Git resume-*.log evidence. Counts overlap; do not add focused tests to the full suite.

First next action: prepare a fresh guarded native package from274899d and a newly consented synthetic Work task. Verify first capture, then app-only restart and Mac restart separately, preserving the same valid task grant. Inspect native callbacks before reconciliation and use pendingFiles/latest-baseline selection when normalizing. Then disable/purge/uninstall. The old canary remains cleaned up; its partial result is not relabeled as a pass and its purged body was not recovered. This fix is not installed or live-tested. Global telemetry remains ON; normal SkillMeter, shared settings and original dirty checkouts were not changed. No push, PR update, deployment or external message. Pipeline stays3abe812f. Production delivery/analyzer/dashboard gates remain in the repair report.

Earlier checkpoints follow.

# Native canary finished with resume gap, September 16, 2026

User-reported context, September 16: Juho quit and reopened the app, and the MacBook restarted between the first native capture and the final follow-up. This is consistent with the observed SessionStart and prefix-preserving file replacement. The specific process responsible for replacement remains unverified; do not attribute it conclusively to reboot versus app restore. Treat restart/resume as the reproduction scenario and test app-only restart and machine restart separately after the repair. This does not invalidate the first-turn result or excuse loss of a still-valid local capture grant.

Supersedes the pending-follow-up state below. The correct-task follow-up completed with30/60 and unchanged memo. All43 native callbacks dispatched, but resumed SessionStart revoked the capture because the transcript inode changed; the exact committed prefix, task identity, account/device and policy still match. The queue was purged before the follow-up. First-turn capture remains verified; combined two-turn capture is NOT verified. A synthetic exact-prefix replacement reproduces the revocation. See native-canary/RESULT.md, final-evidence.json and resume-reproduction.json.

Cleanup is complete: isolated capture disabled, payloads absent, native control cleared/expired, temporary plugin uninstalled/cache removed. Normal SkillMeter, credentials and policy unchanged; global telemetry ON. No further user canary action is pending. First next action: add a regression and repair Work resume for proven prefix-preserving file replacement while retaining corruption/consent protections, then run deterministic checks before preparing a fresh native canary. Do not restore revoked consent or recover purged bodies. Plugin source remains973d1f4; pipeline remains3abe812f. No production send, push, PR update or external message.

Earlier checkpoints follow.

# Native follow-up location correction, September 16, 2026

User reported Native canary done, but the latest follow-up ran in the earlier task Calculate CSV total minutes. Its answer has the expected30/60. The selected native task Run native work canary still has only the first captured user prompt and38 native callbacks. The second native turn remains unverified. This is a task-location mismatch, not evidence of capture failure or successful two-turn native capture. Only the exact named synthetic tasks were inspected; no transcript bodies were copied into evidence.

Next: user repeats the follow-up in Run native work canary, reading the memo in reports/chatgpt-work-native-canary-20260916/workspace. Preserve the current exact-task binding and first-turn queue until verification. Do not rebind or retroactively collect the earlier task. Control expires September17 08:09KST. After correct-task completion, inspect native callbacks before reconciliation, normalize combined selected chunks, verify30/60 and both prompts/tool links, then disable/purge and uninstall only skillmeter-work-canary@personal. Normal SkillMeter/global telemetry/shared credentials remain unchanged. Cleanup is pending, delivery remains disabled. See native-canary/follow-up-location-evidence.json.

Earlier checkpoints follow.

# Native first prompt passed, September 16, 2026

Task Run native work canary produced memo60. All38 native callbacks passed (1 UserPromptSubmit,18 PreToolUse,18 PostToolUse,1 Stop), with matching native plugin environment and no blocked network attempt. Before manual reconciliation:35 contiguous chunks and464 late bytes; reconciliation added1chunk, zero pending bytes. Normalization produced20messages/1user prompt and15unique outer tool pairs exactly matching selected source IDs, preserved Work identity, no actionable or incomplete-tool diagnostics. Setup prompt excluded. Evidence: native-canary/first-prompt-evidence.json. This proves guarded native-plugin capture, not unmodified production packaging or a dashboard report.

NEXT: user continues the SAME task, calculates total excluding Prepare slides using previously read values, reads memo.md to confirm it retains original total, and changes no files/settings. User returns Native canary done. Assistant inspects native callbacks and combined source/queue, reconciles any final tail, validates expected30 with memo60 and both prompt/tool records, then disables capture, verifies payload purge and uninstalls ONLY skillmeter-work-canary@personal. Preserve normal SkillMeter, global telemetry ON, shared credentials/policy and other plugin entries. No production send or real analyzer call. Current control expires September17 08:09KST. Cleanup still pending second turn.

Earlier checkpoints follow.

# Native canary selected, September 16, 2026

User completed native preflight in the fresh task Run native work canary. Verified source=vscode, originator=codex_work_desktop, runtime0.154.0-alpha.6.2 and exact cwd. Installed candidate0.1.0+codex.20260915232102 now has an enabled future-byte grant and exact task/source/cwd binding in the protected native-canary control file. Setup tail166617bytes is excluded, queue initially empty. Shared credentials/policy unchanged; delivery disabled. This administrative enable is NOT evidence of native hook execution.

Next user prompt, in that same task: read /Users/juhokim/Code/skillbench-all/reports/chatgpt-work-native-canary-20260916/workspace/source.csv, calculate total minutes, write memo.md in the same folder with the total, then stop without telemetry changes. User replies Native first prompt done to the original telemetry task. Assistant then inspects only the selected task, native events and local queue before providing the second prompt. Expected first total60 and follow-up excluding Prepare slides30. Do not count manual reconciliation as native hook evidence. Cleanup remains pending after both turns. Guard expires September17 08:09KST.

See native-canary/selection-evidence.json and native-canary/README.md. No private transcript copied, upload, message to engineering, push or PR update.

# Native plugin canary prepared, September 16, 2026

Current source checkpoint de8c5b9f4f98716faf301dad3f72b2e1ed0ac5f4. Separate local skillmeter-work-canary@personal 0.1.0 is installed. It embeds the unchanged 973d1f4 candidate behind seven packaged, exact-task guarded hooks; no user-hook bridge, normal SkillMeter replacement, delivery or shared-auth change. Four guard tests and seven installed unselected checks pass; candidate 101 files match. No task selected and no live evidence. Control expires September 17 at 08:09 KST.

NEXT: user selects SkillMeter Work Canary in a fresh local Work task, reviews its seven hooks, runs only the setup prompt in native-canary/README.md, and replies Native preflight done. Then locate only that named task, verify metadata, enable future-byte grant and bind control before the actual synthetic task. No automatic trust bypass or marker-based selection. Native UI/dispatch remains unverified. See native-canary/README.md for the manual prompt, binding, normalization and cleanup procedure. Pipeline current source 3abe812f. No pushes/PR updates/communication.

Earlier checkpoints follow.

# Analyzer repair checkpoint, September 16, 2026

Supersedes the two analyzer gaps below. Pipeline commit 3abe812f98e625ff17e5719c816edfa31275ddcf on codex/work-normalization-20260915 fixes empty-report generation and retains supplied agent/surface/originator through internal parse/classification/task analysis. Ineligible real sessions return the existing insufficient-activity skip with zero model calls, no report artifact and no ingest; worker acknowledgement and accurate CLI output are tested. Eligible companions still produce reports, and missing legacy source fields stay missing. No threshold, scoring prompt or public report schema changed.

Seven initial regression cases failed before repair and pass after. All 333 analyzer tests pass, including existing Claude/parse/report snapshots; 18 existing datetime warnings. The changed-file Ruff comparison against e17bf5f2 has zero new findings (44 existing findings become 43). Work compatibility lint/format passes when run from the analyzer app directory. See pipeline docs/work-analyzer-repair.md for evidence and limitations. Plugin source remains 973d1f4; its earlier full test and installed-command results remain valid historical evidence, not a fresh native canary.

First next action: prepare native desktop plugin selection/trust and dispatch validation on a fresh synthetic local Work task without the temporary marker bridge. User interaction may be needed for trust/selection. No additional policy decision blocked these source fixes. General Work eligibility/rubric, task consent/shared credentials and approved environment/user/report mapping remain production gates. Do not infer permission to send real Work bodies or alter scoring.

User handles communication. No messages, remote pushes, PR changes or deployments. Both isolated Work branches remain local and stacked on the existing draft repairs; original dirty checkouts unchanged. No global telemetry/config/auth changes. Use the exact pipeline commit above for the next local parser/analyzer check.

## Earlier checkpoints

# Technical checkpoint, September 16, 2026

Current milestone supersedes the earlier expiry-gap checkpoint below. User handles team communication. No GitHub/Slack messages, remote pushes, PR changes, release, deployment, schedule, historical replay, shared-auth migration or production Work delivery occurred.

- Plugin source fix: 973d1f4dce4b00f112b0a5c239566890c28c1944 on codex/work-capability-20260915. Existing task consent and queued data survive token expiry; new grants require an unexpired token; restart/renewal/identity-change/terminal-purge regressions pass. Read-only shared credentials are preserved.
- Pipeline tests/documentation: e17bf5f208af9e4d012891984c2b855b2b0ec764 on codex/work-normalization-20260915. Three synthetic tests cover real report/schema assembly, mixed unsupported input and the short-session parser threshold. No scoring or production analyzer source changed.
- Validation: 453 Node tests, 55 lifecycle scenarios, both review probes; 321 analyzer tests; Python lint/format and whitespace checks. Counts overlap with focused tests and must not be added together.
- Supported CLI installation in reports/chatgpt-work-canary-20260915/native-package-check/codex-home matches all 101 plugin source files. All 12 installed manifest commands pass with synthetic isolated state and network blocked. Does not establish desktop native dispatch/trust. Normal installation unchanged; global telemetry remains ON; temporary user hooks remain removed.
- New analyzer finding: structured source identity survives, but analysis session dictionaries drop source/surface and prompts still assume developer/Claude Code work. Short sessions are filtered; the job can still assemble an empty-task report with 13 scripted calls. These are limitations, not acceptance successes. See pipeline docs/work-analyzer-compatibility.md.

First technical action next session: add a failing job-level regression for no analyzable sessions and implement an explicit outcome consistent with existing job consumers. Preserve Work surface through analysis as part of reviewed Work scoring support. Do not lower the threshold just to pass a canary.

Native canary gate: select the exact corrected candidate through the supported app plugin flow, review/trust its hooks, start a fresh synthetic local Work task with explicit task consent, verify native hook dispatch without the temporary marker bridge, reconcile/normalize, then disable and verify cleanup. Actual app trust/selection may require the user. No raw/private transcript should enter a checkpoint.

Production gates: agree task-selection UX and grant policy, shared credentials under INF-177/INF-200, analyzer eligibility/rubric and corruption behavior; identify an approved environment/account and authenticated user/report mapping. Only then implement gated Work delivery and trace one approved real task through stored sanitized chunks, normalization, actual analysis and the existing correct-user dashboard. Cloud/ordinary chat remain separate. Existing PR37/148 are unchanged; Work branches are local and stacked, original dirty checkouts untouched.

## Historical checkpoints

Engineering review milestone, September 16, 2026. See ENGINEERING-REVIEW.md and ENGINEERING-MESSAGE-DRAFT.md in the Work plugin branch. The message is a draft only; no comment, Slack message, remote branch or PR update was sent.

Source fix c80c3c998028ec17c1391a2d3e7b18b70a6345c9 makes Work identity checks read-only and rejects incomplete credentials without initializing device/salt. Tested with 449 Node tests, 55 lifecycle cases and the synthetic queue-to-parser check. This source fix is NOT installed; the live canary continues to attest to 3022a12, recorded in aa21c9e. The new review-probes.cjs reproduces one remaining production lifecycle gap: token expiry revokes active Work capture and purges its queued data. It exits 1 with a named gap. Read-only credential probe passes. Preserve this distinction rather than treating all tests as green.

First action next session: use the packet to settle Work task consent duration/renewal and the existing shared-credential contract under INF-177/INF-200; then implement expiry capture/retention parity before enabling delivery. Do not reuse the temporary marker bridge as shipping UX or run a production canary without approved environment, identity/report mapping and analyzer suitability. TEL-7 was closed by transfer to INF-177, not by proof of completed multi-day tests.

Both Work branches remain local/stacked. PR37 and PR148 are still draft at 8cb4a4d/fd5a758; PR38 is open/non-draft at 7bb34922. Fresh remote mains unchanged: plugin 13b4648761aae7e9ebb20477276c13a416460173, pipeline f3d6710aa1ce4ca26fcb40c621ebf8bf618f34e1. Pipeline Work head remains 32266389bdeaaef606924b3719d750c6e6ee46c9. Original dirty checkouts untouched. Global telemetry remains ON; temporary canary hooks remain removed.

Latest status, September 16: local two-turn Work canary PASSED and temporary hooks/queue were removed. Global telemetry remains ON. See CANARY-PASS-20260916.md and final content-free evidence. No further manual canary action pending. Earlier failed/preparation checkpoints below are historical.

Current status, September 16: Work task passed but capture did not activate. Temporary hooks are removed; global telemetry remains ON. See CANARY-RESULT-20260916.md for the correction, evidence and exact resume steps. Earlier preparation states below are historical.

# Resume checkpoint: local Work source implementation

Update, September 15: user explicitly requested global telemetry ON. Both the shared policy and effective candidate gate now report ON. A legacy telemetry_disabled flag was cleared through the existing toggle; other credential fields and org/repo decisions were verified unchanged. Four scoped user hooks are registered, tested and awaiting runtime trust; no task is selected yet. See CANARY-RUN.md (tracked) or reports/chatgpt-work-canary-20260915/README.md for the exact two manual steps. Earlier OFF-blocker details below are historical.


Canary preparation update: the exact candidate is installed in a separate cache and its 18 Work tests pass. Live capture is blocked by existing global telemetry OFF, pending the user decision. No new user hooks are registered. See [CANARY-PREPARATION.md](CANARY-PREPARATION.md).

September 15, 2026. The selected-task local capture adapter and Work normalization are implemented and tested. This is source/test completion for the bounded experimental adapter, not live installation, production delivery, a dashboard report or cloud support.

## Exact source checkpoints

- Plugin: `.worktrees/chatgpt-work-capability-20260915`, branch `codex/work-capability-20260915`, source commit `7ec8951dad4616dccb52f8e2caf18f60eaed5a44`. Parent capability checkpoint: `f288f8858dd5047925a703ed01efa0e97c5e14bf`. A following documentation commit records this checkpoint.
- Pipeline: `.worktrees/chatgpt-work-pipelines-20260915`, branch `codex/work-normalization-20260915`, commit `32266389bdeaaef606924b3719d750c6e6ee46c9`.
- Existing repair checkouts remain clean and unchanged: Codex PR37 source `8cb4a4d5fd763e4c4ff0681b9071ac864159cdb0`; pipeline PR148 source `fd5a75814e1622949d13eb54452251274aef5ac4`. Original dirty repository checkouts were not edited. No PR was updated, no new remote branch was pushed.
- Remote main revisions observed before source work: plugin `13b4648761aae7e9ebb20477276c13a416460173`; pipeline `f3d6710aa1ce4ca26fcb40c621ebf8bf618f34e1`. Work candidates are stacked on repair candidates, not rebased onto these mains.

## Outcome and evidence

The candidate supports explicit 24-hour consent for one exact local Work task, excluding pre-consent content. It reuses the existing sanitizer, chunk/cursor queue and retirement implementation. It binds task/path/file/cwd/device/principal/tenant/global consent state. Work staging is separate from the production upload queue. Stop/reconcile handles records written after earlier callbacks; incomplete bytes and queue errors stay visible. Logout/global OFF/identity change/revocation cannot silently resume old consent. Work originator and surface survive structured and flat normalization; contradictory known source identities remain diagnostic. Missing legacy originator does not become a false conflict.

Validation: 432 Node tests, 55 offline lifecycle scenarios, 190 preprocessor tests, 318 analyzer tests, 322 synthesizer tests and six subtests pass. Preprocessor Pyright has zero errors; changed Python files pass Ruff and formatting checks. Version/manifest checks and git diff whitespace checks pass. The synthetic queue-to-parser bridge preserves three messages and one outer exec call/result pair, with tested pre-consent and opaque-command sentinels absent. Consumer tests used synthetic/replay paths; no real model invocation or production data access. Existing analyzer tests emit 15 deprecation warnings.

Details and candidate commands: `IMPLEMENTATION.md`. Pipeline details: `docs/work-local-normalization.md` in its Work checkout. New deterministic fixture: `fixture/local-work-runtime.jsonl`. `check_implementation.py --pipeline <Work pipeline checkout>` is the current acceptance script; the older compatibility script intentionally remains a historical baseline characterization.

Runtime used: Node 22.22.3; Python 3.14.6 from `.worktrees/codex-telemetry-m0-20260904/skillbench-pipelines/.venv/bin/python`. No dependency or runtime installation was performed. The earlier installed Work hook probe remains removed; user hooks/config/credentials were not changed in this implementation run.

## First action next session

Review the two Work source diffs, then prepare the exact candidate in an isolated local canary configuration and use a fresh synthetic local Work task. Confirm actual cwd and originator, explicitly enable that task, exercise a follow-up/tool/result/final answer, reconcile after the final write, inspect sanitized queued output with the candidate parser, and disable/verify deletion. Do not reuse the earlier probe's success as proof that the new implementation has been live-tested. The assistant can locate the exact selected task's file; the user need not paste or upload logs.

This synthetic local canary can proceed before a production policy decision. Before any real-work upload or report: agree non-repo consent and common credentials with Seungho/Homin, choose an approved candidate deployment/environment, validate general-work analyzer suitability and user/tenant/report mapping, then trace one approved real session all the way to the existing dashboard. Keep the prior repair review discussion separate unless engineering requests a combined change.

Remaining risks: synchronous bounded staging needs large-session hook latency measurement; inner exec semantics, binary attachments and hosted-tool coverage remain partial/unknown; the current analyzer rubric targets developers. Source originator is not execution-host proof. Cloud and ordinary chat need independent supported-access validation. No release, merge, deployment, schedule, history replay, shared-auth schema change or live upload occurred.

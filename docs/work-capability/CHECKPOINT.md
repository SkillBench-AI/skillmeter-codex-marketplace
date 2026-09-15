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

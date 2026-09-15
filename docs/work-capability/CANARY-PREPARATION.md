# Work candidate canary: installed, capture blocked

September 15, 2026. The user requested proceeding to the isolated candidate canary. The local marketplace and plugin were successfully installed with the supported Codex 0.154.0 CLI into a separate CODEX_HOME:

`/Users/juhokim/.codex/work-local-canary-20260915/runtime`

Installed plugin: `runtime/plugins/cache/skillbench/skillmeter/0.4.1` under that directory. All 101 files are byte-identical to plugin source in commit `85e43ccf942cf0ae70f0101b68f70cfb962ba8d3`; aggregate tree digest `3e2740e738d205d6841798071556a0857ce6d5e3ff2e70abc98a17ff30402acd`. The existing default plugin cache was not replaced. Candidate state is isolated using `PLUGIN_DATA=/Users/juhokim/.codex/work-local-canary-20260915/data`. Credentials are read from their existing location, not copied.

Validation: 18 Work tests pass against the installed copy. The synthetic queue-to-parser bridge passes against pipeline commit `32266389bdeaaef606924b3719d750c6e6ee46c9`. A separate installed-runtime synthetic check confirms that global OFF blocks task registration and leaves task capture disabled. No real transcript was collected; no hook trust was bypassed; no production telemetry was sent.

The live canary is blocked because existing SkillBench global telemetry is OFF. The license is present, unexpired and has a valid tenant route and stable principal. Credential bytes were unchanged by the preflight. The workspace root classifies as `no_repository`. Do not bypass global OFF with fixture credentials, an alternate policy store or a patched gate for a live task.

An asynchronous user decision was requested: keep telemetry globally OFF and prepare only, or temporarily enable it for the live canary. No answer was received before this checkpoint. Enabling can also resume collection in other previously approved repositories. The shared setting remains OFF. No user-level hook bridge has been registered or trusted, and no selected-task consent exists. An isolated CLI installation alone does not mean the desktop Work runtime has loaded the plugin.

First action next session: resolve the global consent decision. If approved, arrange the bounded Work hook loading/trust step, preserving the installed release and using the separate candidate state. The desktop shares its normal profile, so a scoped temporary hook bridge may be required; it must accept only the explicit canary marker and then one exact task, enforce a short expiry and never run capture outside that task. Installing hooks does not grant trust; the user must review the new definitions in the runtime UI. Existing hooks add together rather than replacing one another, so verify there is no duplicate sender for the selected non-repository task. Current official source: https://learn.chatgpt.com/docs/hooks .

The fresh synthetic source file is ready at `/Users/juhokim/Code/skillbench-all/reports/chatgpt-work-canary-20260915/workspace/source.csv` (total 60 minutes; excluding Prepare slides, 30). Once consent and runtime setup are ready, start one fresh local Work task, verify its actual cwd and originator, register that task, exercise prompt/tool/result/final answer, reconcile, normalize and compare against the action ledger. Disable and verify deletion afterwards. Save only sanitized/content-free evidence. No production delivery/report or cloud support is claimed.

Evidence: `installation-evidence.json` and `installed-tests.tap` in this report directory. Source/test implementation detail remains in the plugin branch's `docs/work-capability/IMPLEMENTATION.md`. Original dirty checkouts and prior repair PRs remain unchanged. No release, deployment, schedule, shared authentication edit, remote push or historical replay occurred.

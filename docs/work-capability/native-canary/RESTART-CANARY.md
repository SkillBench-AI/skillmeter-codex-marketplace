# Repaired native Work restart canary, September 16, 2026

Installed local plugin skillmeter-work-canary@personal version 0.1.0+codex.20260916045017, display SkillMeter Work Canary. Candidate source274899d93c003354d2a431043315436f43abdef4; pipeline3abe812f98e625ff17e5719c816edfa31275ddcf. All101 candidate files match. Seven installed unselected-hook checks and four synthetic wrapper tests pass. Normal SkillMeter/shared credentials/policy/marketplace were unchanged. No user-hook bridge, selected task, captured body or production delivery.

Readiness caveat: the existing SkillMeter token was expired at preparation. A new grant requires a valid token; do not bypass this gate. Normal SkillMeter startup may refresh it using its existing flow. After setup, check token status again before enabling the grant. If still expired, guide normal scoped sign-in; do not initialize alternate credentials or change org scope, grant duration or shared authentication configuration.

## User step now

Create a NEW local Work task with the SkillBench Engineering folder and On your computer selected. Choose SkillMeter Work Canary in Plugins. Refresh /hooks and review the seven canary hooks. Expected command root: personal/skillmeter-work-canary/0.1.0+codex.20260916045017/native-hook.cjs. Review only this source, not all plugins. SessionEnd/Interrupt timeout3seconds, other events4seconds. Do not continue on hook-loading errors.

Send only this setup prompt:

> Work restart canary 20260916. I consent to local-only SkillBench capture of this one synthetic task for this canary, after the original telemetry task explicitly selects it. Run pwd and tell me the working directory, then stop. Do not read other files or configure telemetry.

Return to the original telemetry task and say Restart preflight done. Do not quit the app or restart the Mac yet. Setup is excluded from capture. The assistant must verify the exact fresh task, native Work metadata and valid existing authentication, then enable future-byte capture and bind the new control before the actual test prompt. No logs need uploading.

## Operator checkpoint and staged tests

Control: /Users/juhokim/.codex/work-native-resume-canary-20260916/config.json. Expiry: 2026-09-17T13:50:17.459000+09:00. It currently has null selected/cwd/transcript. Plugin data and content-free events live in this same control directory. Old canary control remains disabled. Source package: /Users/juhokim/plugins/skillmeter-work-canary. Previous source archived at /Users/juhokim/plugins/.skillmeter-work-canary-before-resume-20260916. Do not confuse the old task with this new test.

Synthetic workspace: /Users/juhokim/Code/skillbench-all/reports/chatgpt-work-native-resume-canary-20260916/workspace. source.csv holds Read notes10, Discuss plan20, Prepare slides30. No memo exists yet.

After successful binding, give only one step at a time:

1. Read source.csv, calculate total60, write memo.md, stop. Verify native callbacks, queue, source identity/tool linkage and exclude setup. Reconcile late bytes separately from native evidence.
2. User quits/reopens ONLY the app, reopens the SAME task, calculates total excluding Prepare slides30 and reads memo to confirm60. Verify native SessionStart and retained current grant, then reconcile and normalize.
3. After step2 is verified, user restarts the Mac, reopens the SAME task, calculates total excluding Read notes50 and reads memo to confirm60. Verify again. A valid unexpired grant is required across the boundary; never silently extend it.

Use queue.pendingFiles/latest-baseline selection for normalization. Replacement produces a new snapshot baseline; concatenating all historical gzip files would count superseded records twice. Compare normalized user messages and exact outer tool call/result IDs against the consented tail of the selected raw source. Record native callback status before manual reconciliation, old/new inode and prefix continuity as content-free booleans. Do not automatically replay the previous canary or inspect unrelated tasks.

After completion or a blocking failure, disable capture with the installed candidate and its configured PLUGIN_DATA/state directory, verify purge, clear/expire control, and remove only skillmeter-work-canary@personal using the supported CLI. Verify normal SkillMeter, global telemetry and shared auth/policy unchanged. Keep only content-free evidence. This remains guarded native packaging, not unmodified production-plugin or dashboard proof.

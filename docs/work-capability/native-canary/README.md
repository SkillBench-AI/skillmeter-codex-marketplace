Update September 16: the user screenshot confirms native desktop discovery of SkillMeter Work Canary and seven hooks awaiting review. The initial package incorrectly requested 4-second SessionEnd/Interrupt timeouts; desktop clamps those to 3 seconds. Corrected both source preparation and local package to 3 seconds, validated a fresh build, reinstalled through the supported cache-buster flow as 0.1.0+codex.20260915232102, and passed all seven unselected installed checks. No task selected, no trust bypass, no capture. Click Refresh in the desktop Hooks page, open the SkillMeter Work Canary row, review the updated hooks and start a fresh local Work task. The normal SkillMeter panel showed the same canary-path warnings; do not infer that normal plugin hooks need modification. Earlier version references below identify the initial installation.

# Native desktop Work canary, September 16, 2026

Prepared and installed; actual desktop discovery/trust/dispatch is pending.
This is a separate local test plugin, `skillmeter-work-canary@personal` version
0.1.0, displayed as **SkillMeter Work Canary**. The normal SkillMeter package
remains installed. No user `hooks.json` bridge was restored.

## User steps now

1. Open a fresh **Work** task and choose **On your computer**, with the existing
   SkillBench Engineering folder. Select **SkillMeter Work Canary** in Plugins.
   If it is missing, refresh the app's plugin list; the View link below opens
   the local listing. Do not replace or reinstall normal SkillMeter.
2. Open `/hooks`. Review and trust only hooks whose command points to
   `personal/skillmeter-work-canary/<version>/native-hook.cjs`. There are seven:
   SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd and
   Interrupt. Other plugins add to the totals, so total counts alone are not
   proof. Do not use Trust all or a hook-trust bypass. If the plugin or hooks
   are missing, stop here and report that state rather than using the old bridge.
3. Send this first prompt in that Work task:

   > Native Work canary setup. I consent to local-only SkillBench capture of this one synthetic task for this canary, after the original telemetry task explicitly selects it. Run pwd and tell me the working directory, then stop. Do not read other files or configure telemetry.

4. Return to the original telemetry task and say **Native preflight done**.
   Do not run the actual test prompts yet. The assistant will locate only this
   named synthetic task, verify its source identity and enable future-byte
   capture. No logs need to be pasted or uploaded.

The first prompt is setup only and is excluded from capture. Installation alone
does not enable task capture, and current hooks are skipped until reviewed.
Official references: [hook trust and plugin loading](https://learn.chatgpt.com/docs/hooks),
[local plugin development](https://learn.chatgpt.com/docs/build-plugins).

## Implementation and evidence

The candidate embedded under `candidate/` is byte-identical across 101 files to
plugin source `973d1f4`. Seven root manifest-default hooks dispatch the native
canary entry point, which checks an operator-controlled exact task ID, cwd and
transcript path plus expiry and Work metadata before launching the original
candidate handler. A child-only network/subprocess guard blocks delivery; data
uses a separate canary directory. The wrapper never auto-selects from a marker.
It records only bounded event/status/timing/hash flags for the selected task.

This packaging deviation is deliberate: it tests native plugin discovery and
dispatch of guarded candidate code without enabling candidate repository hooks
globally. It does not prove the unmodified release manifest is production-ready.

Four test cases pass: unselected/expired denial before source access; unrelated
task/cwd/path/event denial; changed source identity denial; selected synthetic
Stop staging through the unchanged candidate with no delivery or credential
mutation. Seven installed unselected-command checks pass. Plugin validation
passes. `preflight.json` contains content-free results; no live hook invocation
is yet attested. Pipeline for later normalization: `3abe812f`.

## Operator resume and cleanup

- Source package: `/Users/juhokim/plugins/skillmeter-work-canary`.
- Local listing: `/Users/juhokim/.agents/plugins/marketplace.json`. This is the
  plugin system's local marketplace name, not Personal GBrain or a change in
  company memory routing.
- Installed: `/Users/juhokim/.codex/plugins/cache/personal/skillmeter-work-canary/0.1.0`.
- Control: `/Users/juhokim/.codex/work-native-canary-20260916/config.json`.
  It expires 24 hours after preparation. `selected`, `cwd`, `transcript` start
  null. Shared state stays at `~/.skillbench`; it is read, never copied.
- After the user setup, locate only the named fresh task. Check actual metadata
  `source=vscode`, `originator=codex_work_desktop`, id/cwd and canonical source
  path. Invoke the installed candidate `scripts/work-local.js enable` using
  the control file's `PLUGIN_DATA` and `SKILLMETER_STATE_DIR`; then write those
  exact bindings to the control file. Verify future-byte grant and status.
- Ask for a synthetic arithmetic/tool task, then inspect events and queued
  output before the follow-up. Native evidence must have matching plugin-root
  and plugin-data flags, valid Stop output and no blocked network attempt.
  Reconcile after the final response, normalize through the candidate pipeline,
  and compare source/tool linkage. Only selected-task content may be inspected.
- Cleanup: disable Work through the same installed candidate/environment and
  verify queue deletion, clear the selection, then `codex plugin remove
  skillmeter-work-canary@personal`. Preserve normal SkillMeter, shared policy,
  credentials, other local marketplace entries and hook trust. Keep only
  content-free evidence. Do not perform production report delivery.

Reproduction: scaffold with Plugin Creator's `create_basic_plugin.py
skillmeter-work-canary --with-marketplace --with-hooks`, then run this directory's
`prepare.py <fresh-source-package> <new-control-json>`, validate and install with
`codex plugin add skillmeter-work-canary@personal`. Preparation refuses an
existing candidate/control file. Do not rerun against the current installed
package. Changes require the supported cache-buster/reinstall flow and fresh
hook review.

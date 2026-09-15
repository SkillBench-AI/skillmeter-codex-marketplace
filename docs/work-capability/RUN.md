# Run the local Work probe

Installed September 15, 2026. Expires September 16 at 20:09 KST. No SkillBench credentials or uploader are used by this probe. Its seven hook groups are registered in the newly created `~/.codex/hooks.json`; existing config.toml and plugin hooks were left unchanged. The callback is inert outside the exact folder below, before the initial marker, for any other session after binding, and after expiry.

## 1. Review the new hooks

Open Terminal and run:

```sh
codex -C /Users/juhokim/Code/skillbench-all/reports/chatgpt-work-telemetry-20260915/synthetic-workspace
```

In that CLI, enter `/hooks`. Review and trust only the seven new commands referencing:

```text
/Users/juhokim/.codex/work-capability-probe/probe.py
```

They handle SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, Interrupt and SessionEnd. Do not use “trust all” for unrelated hooks or a trust-bypass flag. Quit the CLI without sending a task prompt. This step reviews user-level hook definitions; it is not the Work canary. Whether the desktop runtime honors the resulting trust must still be observed. If the app asks to review the same hooks, review them there too.

The runtime requires review of new hook definitions before running them. Computer Use denies access to this app, so the assistant cannot perform that UI step. This is a runtime trust requirement, not a SkillBench credential change. See [OpenAI hooks](https://learn.chatgpt.com/docs/hooks).

## 2. Start the actual Work task

In ChatGPT, use **Work → On your computer**. Set the task folder to:

```text
/Users/juhokim/Code/skillbench-all/reports/chatgpt-work-telemetry-20260915/synthetic-workspace
```

Use this folder itself, not its SkillBench Engineering parent. It contains only the synthetic source.csv and is outside Git. Start a fresh task so configuration is loaded. If new hooks are not visible, restart the app before continuing; do not change shared auth or managed policies.

Paste:

> WORK-PROBE-20260915-A. This is an entirely synthetic local Work capability test. Use only source.csv in this task's folder. Read its three activities, use a local tool to calculate total minutes, and write a short memo.md summarizing the result. Return the total and the filename. Do not access connected accounts, other folders, or the internet. Do not create subagents.

Expected total: **60 minutes**. The unique marker arms the probe for this one session. Do not paste this marked prompt in the CLI.

After the response, close and reopen the same Work task and paste:

> WORK-PROBE-20260915-B. Exclude Prepare slides and give me the revised total. Use a local tool to verify the calculation. Continue using only this synthetic task folder.

Expected total: **30 minutes**.

## 3. Return here

Tell this original task **“Work probe done.”** No logs need to be pasted or uploaded. The assistant can inspect the local, content-free evidence and update the coverage matrix. Do not run optional web/interrupt extensions until this baseline is confirmed.

Evidence lives under `~/.codex/work-capability-probe/evidence` with owner-only permissions. It stores hook event names, a session hash, transcript availability/outcomes, bounded record counts, hashed call-link counts and synthetic marker flags. It does not save arbitrary prompt text, commands, tool outputs, source paths or full transcript copies. Numeric marker flags are presence checks, not proof of a correct calculation; compare the visible answers separately.

The probe reads only the exact hook-supplied file after checking its session metadata against the selected session and workspace. It rejects missing/unsupported metadata, symlinks, non-regular files, identity mismatch, and sources above 2 MiB. It does not discover history or read application databases. No evidence may mean a wrong task folder, untrusted/unloaded hooks or an input/runtime incompatibility; it is not evidence that no work occurred.

## Disable/remove

The callback stops recording automatically at expiry; hook entries remain inert until removed. To remove only its exact registered hook groups while preserving other configuration:

```sh
python3 /Users/juhokim/Code/skillbench-all/.worktrees/chatgpt-work-capability-20260915/docs/work-capability/remove_probe.py
```

Local evidence is retained for review. Do not extend expiry, reset the selected session or reinstall automatically without a new bounded run.

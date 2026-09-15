Completed September 16: the local Work canary passed; temporary hooks removed. No more user steps are required. These instructions are historical and must not be rerun without fresh assistant preparation. See the final canary report/checkpoint.

Current status, September 16: this attempt is complete and its temporary hooks have been removed. Capture did not activate. Read the latest CHECKPOINT.md before restarting; the assistant must reinstall the corrected bridge first. The instructions below are retained as a prompt template.

# Fresh Work canary: two manual steps

Global telemetry is now ON at your request. The prior legacy OFF flag was also cleared through the existing toggle; authentication fields and organization/repository choices were preserved. The candidate is installed separately and still has production delivery disabled. Its four temporary hooks have passed ten boundary/cleanup tests and an installed rejection smoke check. No actual Work task has been captured yet.

## 1. Review the four canary hooks

Open Terminal and run:

```sh
codex -C /Users/juhokim/Code/skillbench-all
```

Enter `/hooks`. Review and trust only the four new commands containing:

```text
/Users/juhokim/.codex/work-local-canary-20260915/hook.cjs
```

They are UserPromptSubmit, PreToolUse, PostToolUse and Stop. Do not use “trust all” for unrelated entries. Quit the CLI without sending a task prompt. This is only the hook-review step; the actual canary runs in Work.

The runtime requires trust for newly installed hook definitions. The assistant cannot perform the trust UI step with the available computer-use access. This is the [OpenAI hook trust requirement](https://learn.chatgpt.com/docs/hooks), not another request to approve the source change. The desktop may also show a review notice for these definitions; approve only these same four. If it has not loaded the new hooks, restart the app before starting the fresh task.

## 2. Start a fresh local Work task

In ChatGPT choose **Work → On your computer**, using the existing **SkillBench Engineering** project whose primary folder is `/Users/juhokim/Code/skillbench-all`. The synthetic folder already exists; no new folder or attachment is needed. Adding a folder to a task does not necessarily change its primary cwd.

Paste this exact prompt, starting with the marker:

```text
WORK-CANARY-20260915-7ec8951. I consent to local-only SkillBench capture of this one synthetic task for this canary. Read only /Users/juhokim/Code/skillbench-all/reports/chatgpt-work-canary-20260915/workspace/source.csv. Use a local tool to calculate total minutes, then write memo.md in that same workspace folder with the total. Reply with the total and filename. Do not use connected accounts, the internet, other files or subagents.
```

Expected result: **60 minutes**, `memo.md`. Return to the original assistant task and say **“First Work prompt done.”** The assistant must verify selection and queued capture before proceeding. Once confirmed, in the same Work task, send:

```text
Use a local tool to recalculate the total excluding Prepare slides. Do not modify the files. Reply with the total only.
```

Expected result: **30 minutes**.

Return to the original task and say **“Work canary done.”** The assistant will inspect the exact selected task, reconcile late writes, normalize the sanitized local queue, verify expected answers/tool linkage, save content-free evidence and remove the temporary hooks. You do not need to find, paste or upload logs. If you see a hook warning or different result, report it instead.

## Scope and cleanup

The hook bridge starts only on the exact marker in the specified workspace and an actual Work transcript. It then binds permanently to that one task. It runs the installed candidate's actual prompt/tool/Stop hook scripts using separate candidate state. A subprocess guard blocks network and spawned processes in those hook scripts; it does not alter the Work agent's own tools. The released plugin cache is unchanged. The workspace is non-Git, so it does not inherit repository consent. Initial metadata and startup instructions remain excluded under the candidate's consent boundary.

Bridge expiry: **September 16, 21:22 KST**. This is a check performed by the hook, not a scheduled job. No hook trust was bypassed. The CLI installation is separate; these temporary user hooks connect that exact candidate to desktop Work. This tests the candidate through the bridge, not native marketplace discovery in desktop.

To stop the candidate and remove only its four hooks now:

```sh
node /Users/juhokim/.codex/work-local-canary-20260915/remove.cjs /Users/juhokim/.codex/work-local-canary-20260915/install-receipt.json
```

Removal leaves unrelated hooks, the installed release and global telemetry unchanged. No automatic global-OFF restoration is scheduled. The assistant will handle normal canary cleanup after inspecting the result. Production report delivery, general-work analyzer suitability, correct-user dashboard mapping and cloud support remain separate gates.

# Synthetic local Work action checklist

Status: prepared, not executed in ChatGPT Work. This is a non-coding document task. The adjacent rollout.jsonl is a hand-authored compatibility fixture, not a recording of this procedure. Actual tool names and record shapes must be observed, not forced to match the fixture.

## Before starting

- [x] Confirm the ChatGPT app exposes a Work task with Local execution. User screenshot on September 15 shows Work selected and On your computer checked. Actual task execution remains untested.
- [ ] Prepare an isolated non-Git folder containing only fixture/source.csv. Do not use this Git worktree as the task workspace, or the non-repository consent test becomes invalid.
- [ ] Complete the scoped probe setup and review its hook definition once the actual Work configuration route is established. No probe has been installed in this packet. Do not enable the existing uploader globally or bypass trust to make this test work.
- [ ] Verify that the probe targets only this task/folder, records locally, and sends nothing to the SkillBench collector. Record app/runtime versions and observed task ID without user/account secrets.

The machine-local staging folder prepared with this packet is:
`/Users/juhokim/Code/skillbench-all/reports/chatgpt-work-telemetry-20260915/synthetic-workspace`

## Initial prompt

Paste after the setup checks above:

> This is an entirely synthetic local Work capability test. Use only source.csv in this task's folder. Read its three activities, use a local tool to calculate total minutes, and write a short memo.md summarizing the result. Return the total and the filename. Do not access connected accounts, other folders, or the internet.

- [ ] A1: Record evidence that the task is Work and executes locally.
- [ ] A2: Observe the file-read call and its output; rows should be 10, 20 and 30 minutes.
- [ ] A3: Observe the calculation call/result. Expected total: **60**.
- [ ] A4: Observe the file-write call/result, memo artifact, and final assistant message.

## Resume and follow-up

Close and reopen the same task, then paste:

> Exclude Prepare slides and give me the revised total. Use a local tool to verify the calculation.

- [ ] A5: Expected total: **30**. Both user prompts and both assistant final responses survive capture, with no duplicated first turn.
- [ ] Record actual task/session lineage across reopening. Do not claim interruption recovery from reopening alone.

## Optional coverage extensions

- [ ] A6: Ask for a public OpenAI documentation search. Record whether a hosted tool was actually available/used and whether its call/result appears in the transcript, hooks, both or neither. Absence of the tool itself is an availability result, not a lost-record result.
- [ ] A7: Interrupt an ongoing operation and continue. Record whether the call is pending, cancelled or complete, and whether recovery duplicates any earlier content.

## Evidence review

- [ ] Compare observed records against the action ledger, separately for hooks, raw transcript and normalized output.
- [ ] Preserve structured call/result links and final text. Record attachment/image/binary gaps explicitly; do not assume document bytes are automatically part of telemetry.
- [ ] Treat unavailable transcript paths or unrecognized paginated history as explicit partial/unsupported capture outcomes.
- [ ] Confirm no private content or credential reached the evidence folder.

Do not mark these live checks complete based on the offline compatibility tests. Once local capture is demonstrated, non-repo consent, source identity and authorized delivery remain implementation gates.

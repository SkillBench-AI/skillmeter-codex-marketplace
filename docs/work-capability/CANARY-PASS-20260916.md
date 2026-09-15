# Local Work canary passed, September 16, 2026

The corrected temporary bridge captured one fresh, explicitly consented, two-turn ChatGPT Work task running locally. The task returned 60, wrote memo.md with 60, then returned 30 on the follow-up without changing the file. All 10 actual hook invocations succeeded: two UserPromptSubmit, three PreToolUse, three PostToolUse and two Stop. Measured candidate child execution was 111–174 ms; this small task is not a large-session performance benchmark.

Late-write reconciliation completed with zero pending bytes. The 12 contiguous sanitized chunks normalized through the Work pipeline into nine messages, including two user prompts and three matched outer custom tool-call/result pairs. Call IDs matched the selected source transcript. Agent codex, surface chatgpt_work and originator codex_work_desktop survived normalization. There were no actionable parser diagnostics or incomplete tools. The consent cursor excluded the initial 155,298 bytes; startup roles were absent from normalized output and raw opaque call input strings were absent from sanitized chunks. Inner tool semantics remain partial because those command strings are hashed.

Cleanup passed: selected-task capture disabled, no pending purge, all temporary user hooks removed, no queued gzip payloads remain, and credentials and telemetry policy bytes are unchanged. Global telemetry remains ON at the user's request. The installed release and its plugin hooks were not modified. Raw transcripts and sanitized payload bodies were not copied into the handoff; only content-free counts, assertions and a sanitized-payload digest are retained in canary-pass-20260916.json.

## Scope and exact baselines

This is successful live local capture and candidate normalization through a temporary user-hook bridge. It does not establish native marketplace integration in desktop, capture of arbitrary Work sessions, cloud support, production upload, AI-usage analyzer suitability, or a dashboard report. No deployment, release, merge, historical replay, schedule, production data access or shared-auth configuration change occurred.

Plugin Work branch: codex/work-capability-20260915, source/bridge 3022a122d38fdb17f9cac8f98266f8e4769befd4. This documentation checkpoint follows it. Pipeline Work branch: codex/work-normalization-20260915, commit 32266389bdeaaef606924b3719d750c6e6ee46c9. Existing repair PR worktrees and original dirty checkouts remain untouched. Work branches have not been pushed in this run. The bridge correction's 16 deterministic tests passed in the preceding run; this turn performed live acceptance and cleanup verification without changing implementation.

## Resume / remaining gates

No further manual canary action is needed. Begin the next stage by reviewing the Work-specific diffs and this evidence with engineering, agreeing how non-repository consent, common credentials and delivery should be integrated. Keep the experimental Work changes separate from existing Codex repair PRs unless engineering requests otherwise. Production delivery remains disabled.

After that agreement, verify a supported installation path and general-work analyzer behavior, obtain an approved candidate environment and user/tenant/report mapping, and trace one explicitly approved real Work session through collection, normalization, the existing analyzer and the intended dashboard. This requires separate deployment/data-access authorization. Cloud sessions need independent access and coverage validation. Do not turn this successful small local canary into a claim of production readiness.

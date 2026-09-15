# Resume checkpoint: local Work capability complete

September 15, 2026. The real local Work C follow-up passed: UserPromptSubmit, PreToolUse, PostToolUse and Stop each recorded an identity-matched readable transcript. The final answer contained 30. Selected in-memory sanitizer/preprocessor normalization produced 20 messages and nine outer exec call/result pairs, with zero malformed, unsupported or incomplete diagnostics. This is local capability acceptance, not production end-to-end completion.

Branch: codex/work-capability-20260915. Codex candidate base: 8cb4a4d5fd763e4c4ff0681b9071ac864159cdb0. Pipeline tested: fd5a75814e1622949d13eb54452251274aef5ac4. Existing repair PRs were not changed.

Evidence: HOOK-RESULT.md and hook-live-evidence.json. Earlier LIVE-RESULT.md explains why the folder-scoped first run missed the task. Source metadata identifies Work via originator=codex_work_desktop while source=vscode; startup/projection currently drops Work identity. All observed outer calls are exec, so inner operation semantics need separate assessment.

Timing finding: UserPromptSubmit preceded persistence of prompt C; PostToolUse preceded persistence of its output. Stop saw the complete nine pairs. Do not classify those transient gaps as permanent loss; keep Stop/recovery reconciliation in the transport design.

Validation: 8 synthetic compatibility checks, 86 existing scope/sanitizer checks, 15 probe boundary tests, 3 removal-preservation tests, two installed rejection smoke checks, plus the real hook trace and final selected-transcript normalization. Synthetic tests alone are not live acceptance evidence.

Cleanup complete: removed the seven exact probe groups and restored the previously absent user hooks.json to absence. Existing config.toml, plugin hooks and credentials were preserved. Protected evidence remains under ~/.codex/work-capability-probe/evidence. The callback is no longer registered and does not run automatically.

No more user canary action is required for this milestone. Next source work: preserve Work origin, define approved non-repo task/context consent, handle persistence timing, and evaluate inner exec semantics. Shared credentials, authorized delivery environment, analyzer suitability, dashboard canary and cloud feasibility remain separate gates. No private transcript copy, upload, analyzer execution, release or deployment occurred. Work remains locally committed, not pushed.

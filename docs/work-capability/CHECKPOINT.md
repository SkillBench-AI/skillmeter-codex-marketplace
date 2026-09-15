# Resume checkpoint: Work capability packet

September 15, 2026. Offline packet complete. User screenshot confirms Work selected and On your computer checked. The actual local Work canary still needs scoped hook configuration/trust and capture verification. Computer Use denies access to this installed app; no bypass attempted.

Branch: `codex/work-capability-20260915`, based on Codex candidate `8cb4a4d5fd763e4c4ff0681b9071ac864159cdb0`. Pipeline dependency: `fd5a75814e1622949d13eb54452251274aef5ac4`. These are candidate baselines, not main releases.

Completed: app/CLI versions; offline schema inventory; one synthetic CSV/rollout fixture and expected-action ledger; real sanitizer/preprocessor characterization (8 checks); existing scope/sanitizer tests (86); capability report and supported/partial/unsupported matrix.

Probe follow-up: installed seven groups in the previously absent ~/.codex/hooks.json, callback/config under ~/.codex/work-capability-probe. Exact synthetic cwd, unique initial marker, single-session binding, 24-hour expiry and content-free evidence only. Twelve boundary tests and two installed rejection smoke checks passed. No live evidence yet. Work + Local availability is already confirmed and need not be asked again.

First live run inspected: user completed A/B prompts, but the task cwd stayed at the parent workspace and the synthetic folder was attached. Probe evidence remains empty. Targeted inspection of this exact task found readable local JSONL (source=vscode, originator=codex_work_desktop), both final answers, and eight outer tool pairs. Selected in-memory sanitizer/preprocessor check accepted 88 records into 16 messages with no malformed/unsupported/incomplete diagnostics. See LIVE-RESULT.md and live-evidence.json; no transcript text was copied to the packet.

Follow-up prepared: probe is pinned to the exact existing task ID hash plus observed cwd, checked before binding logic even if the state file is absent. It rejects every other task at the workspace root. The selected-session file was created administratively, not by a hook; events.jsonl remains the invocation evidence. Fifteen boundary tests pass. Script/config updated locally; hook definitions, trust and expiry unchanged.

Next action: user opens Calculate Work activity minutes and submits prompt C in RUN.md, then returns with “Hook check done.” Inspect events.jsonl for actual hook invocation and readable transcript. Do not ask for a new folder/task or repeat A/B. Work origin preservation and inner exec semantics remain concrete adapter requirements.

Only the user-selected synthetic Work session was inspected. The new user hooks.json is the only agent-made runtime hook registration change; existing config.toml, credentials, uploader, collector, pipeline source, existing PR, cloud environment and deployment were left unchanged by this task. User trust entries are now present. No new dependencies were installed. No remote push is part of this packet. remove_probe.py removes only exact probe groups and retains evidence.

Do not mark live checklist items passed based on the synthetic rollout. Distinct Work identity, non-repo consent, hosted-tool/media coverage, actual resume/delivery and general-work reporting remain open.

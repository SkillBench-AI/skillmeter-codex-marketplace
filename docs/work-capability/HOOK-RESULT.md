# Local Work hook check passed

September 15, 2026. **A real local ChatGPT Work task invoked the installed hooks, and each callback read its identity-matched transcript.** The final response contained the expected 30-minute result. This completes the bounded local capability experiment, not production telemetry integration.

| Observed hook | Outer calls | Linked results | Transcript |
|---|---:|---:|---|
| UserPromptSubmit | 8 | 8 | Readable JSONL, new prompt not yet persisted |
| PreToolUse | 9 | 8 | Readable JSONL, new call pending |
| PostToolUse | 9 | 8 | Readable JSONL, output record still pending |
| Stop | 9 | 9 | Readable JSONL, new result and final message persisted |

All four observations carry the configured selected-session hash. All snapshots were newline terminated with zero malformed lines. The C marker appeared from PreToolUse onward. These are actual hook-produced events; the earlier administratively written selection file is not counted as invocation evidence.

The final selected transcript also passed the candidate sanitizer and shared preprocessor in memory: **20 normalized messages, nine outer exec call/result pairs, zero malformed/unsupported/incomplete diagnostics**. Pipeline candidate: fd5a75814e1622949d13eb54452251274aef5ac4. No raw transcript copy was saved to the packet. Content-free evidence: [hook-live-evidence.json](hook-live-evidence.json).

## Implementation implications

- Reuse the Codex-runtime collector machinery for local Work, with a Work-specific source/consent adapter. A separate duplicate transport is not warranted by this experiment.
- Preserve the observed `originator=codex_work_desktop` through startup selection and normalization. `source=vscode` alone does not identify Work, and the current normalized label remains `codex`.
- Scope consent to a verified Work task/context. Attaching a folder does not change task cwd. The probe succeeded with both an exact task hash and observed cwd; this is an experiment, not an adopted production consent contract.
- Read transcript deltas again at Stop/recovery. PostToolUse can precede persistence of its output record; do not treat that temporary gap as permanent loss. UserPromptSubmit can likewise precede persistence of its prompt.
- Preserve outer exec linkage while explicitly assessing what can be retained about inner operations after command/patch sanitization.

SessionStart, SessionEnd, interruption, hosted tools, media, cloud execution, general-work report validity and production delivery remain untested. Local success in this runtime does not imply cloud availability or complete support for every history mode.

## Cleanup and next step

The seven temporary probe hook groups were removed after evidence collection. Their user hooks.json contained no other groups, so the file was returned to its prior absent state. Existing plugin hooks, config.toml and credentials were preserved; protected local evidence and the inert probe script/config remain for review. The probe no longer runs automatically.

No further user canary action is needed for this capability milestone. Next implementation work is the Work source/consent adapter and persistence-timing tests. Shared auth, approved delivery environment and report acceptance remain coordination gates with engineering. No collector upload, analyzer execution, dashboard canary, release or deployment occurred.

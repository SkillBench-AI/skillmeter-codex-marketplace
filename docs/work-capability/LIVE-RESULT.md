# First real local Work run

Subsequent C follow-up resolved hook acceptance. See [HOOK-RESULT.md](HOOK-RESULT.md) for the completed experiment and cleanup; the initial-run findings below remain historical evidence.

September 15, 2026. **Local transcript feasibility demonstrated; automatic hook delivery not demonstrated.** The user completed the two-prompt synthetic Work task. No need to repeat the document/calculation task to establish its transcript format.

## Findings

The app task “Calculate Work activity minutes” retained the SkillBench Engineering workspace root as cwd. Its initial user message attached the synthetic folder rather than selecting it as the primary working folder. The file-reading/calculation commands used the synthetic subfolder, but this did not change the task's cwd. The probe's exact-folder guard therefore rejected the task. Its selection/evidence files are absent. All seven user probe hook trust entries are present, the hook definitions and installed script match the installation receipt, and the probe had not expired when inspected. These observations do not independently prove the runtime invoked the hooks.

The app's purpose-built task read exposed the first turn's structured commands, outputs, file change and final response. Its second turn returned no items through that tool, so an empty task-read result cannot be used as evidence of an empty turn.

A filename lookup for this exact synthetic task ID found one local JSONL file. Its startup record matched the selected task ID and observed cwd before the selected transcript was inspected. No unrelated transcript content was read. Startup metadata records `source: vscode` and `originator: codex_work_desktop`. This is one observed local Work runtime, not a universal mapping for every Work version or execution environment.

The file has both initial/follow-up prompt markers and both final answers (60 and 30). It is 683,241 bytes, newline terminated, with no malformed JSONL records in the inspected snapshot. The synthetic memo exists and reports the expected 60-minute total; the follow-up did not request rewriting the memo.

For the compatibility check, eight pre-prompt records were excluded. Minimal source metadata plus the selected post-marker records (88 total) were sanitized in memory and fed to pipeline candidate fd5a75814e1622949d13eb54452251274aef5ac4. No transcript copy was written to this packet. The result was 16 normalized messages and eight linked outer runtime call/result pairs, with zero malformed, unsupported or incomplete-tool diagnostics.

Every outer tool call is named `exec`. This means the existing parser can preserve runtime call/result linkage, but it does not establish that inner shell/file operations retain their own semantic tool identities. Custom-tool inputs are intentionally opaque in the candidate sanitizer. A production Work adapter must explicitly evaluate that tradeoff.

The raw `originator` is not retained in the normalized projection, which still labels the session `codex`. The compatibility invocation supplied the candidate's minimal startup metadata, reflecting the existing startup metadata selection. Preserve a reviewed Work origin field through both collection and normalization; `source: vscode` alone cannot identify this Work session correctly.

## Acceptance matrix for this run

| Check | Result |
|---|---|
| Work + local UI availability | Confirmed by prior user screenshot |
| Exact intended primary folder | Failed setup condition; folder was attached, task cwd stayed at parent |
| Read CSV and calculate 60 | Verified through targeted task-read output and synthetic artifact |
| Create memo | Verified on disk and in task-read file-change record |
| Follow-up and revised 30 | Both prompts/final answers present in the same selected JSONL |
| Readable local transcript | Verified for this exact Work session |
| Sanitizer → shared preprocessor | Accepted selected records; 16 messages, eight outer call/result pairs |
| Automatic hook evidence | None; exact-folder guard excludes this task, invocation remains unverified |
| Work source identity in normalized output | Missing |
| Hosted tools, attachments, interruption | Not tested |
| Collector storage, analyzer, dashboard | Not run |

## Next work

Do not broaden the probe to the whole workspace root or treat this read-only inspection as hook acceptance. For the remaining hook test, either use a fresh Work task whose actual cwd is verified before its marked prompt, or design a probe bound to this exact already-selected task ID with equally strict source checks. The latter could avoid the folder-selection friction, but is not implemented or authorized as a production consent policy by this result.

No need to ask the user for more logs. The content-free evidence is in [live-evidence.json](live-evidence.json). The local probe is still installed until its existing September 16 20:09 KST expiry, with no selected session; it has not been reset, broadened or extended. Existing repair PRs and shared authentication remain unchanged.

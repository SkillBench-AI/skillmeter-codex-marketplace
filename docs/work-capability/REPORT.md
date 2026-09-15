# ChatGPT Work telemetry capability report

Evidence date: September 15, 2026. Result: **offline compatibility packet complete; live Work capture unverified**.

Follow-up: a bounded, metadata-only probe is now installed in the previously absent user hooks.json. Twelve probe boundary tests and two installed-callback rejection smoke checks pass. Hook trust and the actual Work task are pending; no live evidence has been collected. See [RUN.md](RUN.md). Earlier offline test results below remain synthetic only.

Reuse of the Codex sanitizer and structured parser is supported for the tested synthetic Codex-format document task. The existing plugin does not yet support non-repository Work capture or preserve Work identity through normalization. A real Work task must establish the available hook/transcript interface before an adapter is implemented.

## Local inventory and baselines

| Component | Observed revision/version |
|---|---|
| /Applications/ChatGPT.app | 26.908.40834, build 8881; bundle com.openai.codex |
| App-bundled runtime | 0.154.0-alpha.6.2 |
| Installed Codex CLI | 0.154.0 |
| Node | 22.22.3 |
| Default Python | 3.13.5; insufficient for this pipeline |
| Existing isolated pipeline Python | 3.14.6; used without dependency installation |
| Codex candidate used by this packet | 8cb4a4d5fd763e4c4ff0681b9071ac864159cdb0 |
| Pipeline candidate tested | fd5a75814e1622949d13eb54452251274aef5ac4 |
| Codex remote main, read with git ls-remote | 13b4648761aae7e9ebb20477276c13a416460173 |
| Pipeline remote main, read with git ls-remote | f3d6710aa1ce4ca26fcb40c621ebf8bf618f34e1 |

Both existing candidate worktrees were clean at inspection. This packet lives on separate branch `codex/work-capability-20260915`, based on the Codex candidate. Main was inventoried, not tested; the findings below must not be attributed to a main release. No existing repair source/PR was changed.

Computer Use rejected inspection of ChatGPT.app because it resolves to `com.openai.codex`, an app that the tool is not allowed to control. No alternative UI automation or private-history inspection was used. A subsequent user-provided screenshot on September 15 confirms Work selected and “On your computer” checked in the execution selector, with SkillBench Engineering selected. This resolves UI availability and Local selection only; hook registration, trust and actual capture remain unverified. The cloud option is visible in muted styling; cloud availability is not established.

## Runtime finding that changes the probe

Offline schema generation from the installed app binary exposes:

- `historyMode`: legacy or paginated.
- `path`: nullable and explicitly unstable.
- `ephemeral`: threads may not be materialized on disk.
- `originator`: creation origin, independent of current executor/client.
- `threadSource`: optional analytics classification; its creation parameter is client-supplied.
- `thread/read` documentation directs paginated history consumers to `thread/turns/list` and `thread/items/list` rather than full-history hydration.

These are schema capabilities, not observations of a Work task. They establish that a JSONL-only collector needs a format/discovery gate. They do not establish permission to read all tasks or prove that hook JSON uses the app-server schema. Source classification is also not authenticated tenant identity.

See [runtime-evidence.json](runtime-evidence.json) and the reproducible, offline [inventory script](inspect_runtime.py). No active app-server connection was opened.

## Coverage matrix

Status applies to the stated layer. **Supported** means documented at that layer or demonstrated by the bounded test. **Partial** means usable pieces exist but a required part is unverified/missing. **Unsupported** means the stated current implementation/path lacks the capability. Unverified live/cloud capabilities are not labeled platform impossibilities.

| Capability | Status | Evidence and boundary |
|---|---|---|
| Work lifecycle hook mechanism | Supported, documented | OpenAI lists Work among Codex-runtime hook consumers. Installation/trust on this account not tested. |
| Local Work availability and execution selection | Supported, screenshot-confirmed | User screenshot shows Work selected and On your computer checked. No task execution or capture is inferred. |
| Readable raw transcript for a local Work task | Partial, unverified | Nullable hook transcript_path; runtime supports nullable paths and paginated/ephemeral history. No Work task inspected. |
| Non-repo capture through current plugin | Unsupported | Existing licensed-org test rejects non-Git directory with no_repository. Preserve this protection until explicit Work consent is designed. |
| Prompts/final responses in known Codex-shaped records | Supported, synthetic | Four authored messages preserved in this fixture after sanitization. Actual Work record compatibility unverified. |
| Structured local tool calls/results | Supported, synthetic | Four IDs and names, all four result links, text and timestamps survive structured normalization. |
| Sanitizer for tested document-task records | Partial | Email, labeled fake credential and path sentinels removed; call IDs retained. Commands and patch contents intentionally opaque. No claim of comprehensive document/browser/attachment sanitization. |
| Distinct Work identity in normalized output | Unsupported | Synthetic source marker disappears; output remains agent=codex without surface or execution-location fields. |
| Hook-only capture of hosted tools | Unsupported as complete coverage | Official hooks docs exclude hosted paths such as WebSearch. Transcript coverage must be tested separately. |
| Unknown/incomplete/corrupt record diagnostics | Supported, synthetic | Unknown subtype is actionable/nonblocking; truncated JSON is blocking corruption; missing tool result increments incomplete count. |
| Full tool structure through legacy flat export | Unsupported | Flat export removes tool-use blocks; use the existing structured projection where required. |
| Resume, interruption, offline delivery | Partial | Candidate infrastructure exists; this packet tests parser incompleteness only, not live lifecycle/retry behavior. |
| Full binary/image/attachment contents | Partial, unverified | No media fixture or live evidence. A reference in a transcript is not proof the underlying bytes were captured. |
| General-work coaching/report validity | Unsupported as a validated claim | Current candidate prompts are explicitly developer/Claude Code oriented. No general-work evaluation or dashboard run performed. |
| Cloud capture and durable export | Partial, unverified | Cloud uses a separate execution host. Script availability, transcript/export access, credentials, persistence and termination behavior untested. |

## Fixture and test evidence

[fixture/rollout.jsonl](fixture/rollout.jsonl) is hand-authored synthetic input: a 13-record Codex-format hypothesis, not a real Work recording. `source=synthetic-work-hypothesis` is deliberately synthetic and is not asserted to be a Work runtime field value. Source CSV and expected results are independent: 10+20+30=60 minutes; omitting slides gives 30.

- **8/8 offline characterization checks passed**, using the real candidate sanitizer and shared preprocessor. These include assertions of existing gaps, so green does not mean Work support is complete.
- **86/86 existing scope and sanitizer-parity tests passed**, including activated non-Git rejection and Claude PII parity.
- Email, fake credential and absolute source path sentinels were absent from sanitized fixture output. The raw fixture remained unchanged.
- Four authored messages and four tool messages normalize to eight messages with four linked tool results. Unknown-record, truncation and missing-result variants are generated in memory from this one fixture.
- No installed-plugin hooks, uploader, network collector, S3, LLM analyzer or dashboard were exercised.

Fixture SHA-256: `8c679fadb75d1990f398a355412f9f3ab0337316b1272661041e299f1ba1f334`.
Sanitized fixture SHA-256: `1af4907dc6d5b69a7fa7b3fbf216851f6ec2b0807af94e36c7dde1321a2390b6`.

Run from this checkout, using the existing Python environment:

```sh
/Users/juhokim/Code/skillbench-all/.worktrees/codex-telemetry-m0-20260904/skillbench-pipelines/.venv/bin/python docs/work-capability/check_compatibility.py --pipeline /Users/juhokim/Code/skillbench-all/.worktrees/codex-startup-metadata-20260914/skillbench-pipelines
node --test plugins/skillmeter/test/repo-scope.test.js plugins/skillmeter/test/sanitizer-parity.test.js
python3 docs/work-capability/inspect_runtime.py
```

The runner pins the pipeline HEAD. The sanitizer is loaded from this checkout; use this packet's commit to reproduce it. No runtime/dependency download is performed.

## Next action and remaining gates

Work with local execution is now confirmed in the user's screenshot. Next establish its supported task-scoped probe/configuration route and review hook trust. Do not run the existing Git-scoped uploader on arbitrary Work content or create a fake Git repo to bypass its scope rule.

Run the [expected-action checklist](CHECKLIST.md) in the prepared non-Git synthetic workspace only after that setup. Read only the selected synthetic task through its supported transcript/export interface; never scan unrelated history. If paginated history lacks a usable transcript, assess a supported page API with explicit task selection before proposing an adapter. Do not build against undocumented application databases.

The resulting live evidence should decide: raw JSONL adapter versus supported paginated export, reliable Work origin metadata, and whether hooks alone provide only partial coverage. Non-repo consent, authenticated user/tenant delivery and Work report evaluation remain separate engineering/product gates. Coordinate those with Seungho/Homin before live uploads; the offline fixture does not require their production access.

## Sources

- [OpenAI plugin documentation](https://learn.chatgpt.com/docs/plugins): Work hook runtime, script deployment and trust.
- [OpenAI hook documentation](https://learn.chatgpt.com/docs/hooks): nullable/unstable transcript, hosted-tool exceptions, managed policy.
- [Work Cloud security](https://learn.chatgpt.com/docs/enterprise/chatgpt-work-cloud-security): execution host and workspace controls.
- Installed app metadata and offline-generated protocol, recorded in runtime-evidence.json.
- User-provided screenshot, September 15, 2026: codex-clipboard-63c73099-9eb9-48df-bdb0-7d623af20e18.png. Only the UI availability finding is recorded; no screenshot or conversation is copied into the repository.
- Candidate `plugins/skillmeter/scripts/lib/repo-scope.js`, `scripts/sanitizer.js`, and scope/parity tests.
- Pinned pipeline `packages/preprocessor/src/skillbench_preprocessor/{codex,structured,flatten,model}.py`, classifier/analyzer prompts.

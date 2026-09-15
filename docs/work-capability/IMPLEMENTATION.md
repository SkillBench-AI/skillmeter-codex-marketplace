Current status September 16: live local canary passed on 3022a12. Later source fixes c80c3c9 and 973d1f4 make identity reads non-mutating and preserve existing consent/queue through token expiry. The corrected package passes isolated installation and declared-command checks; normal desktop installation is unchanged. See ENGINEERING-REVIEW.md for current evidence and gates. Earlier test counts below are historical.

# Experimental local Work capture

September 15, 2026. Implemented and tested in isolated source checkouts. The installed plugin and user hook configuration have not been changed. Delivery is disabled by construction: Work bodies use `logs/work-local-v1/chunks`, which the production upload list does not enumerate. Recognized Work tasks cannot fall back to repository consent or the repository transcript sender.

## Implemented behavior

A user can explicitly select one exact local Work task and transcript. The experimental grant lasts 24 hours and starts at the current transcript tail. Earlier conversation and startup instructions stay excluded; only a minimal sanitized identity header crosses that boundary. Registration requires existing unexpired SkillBench identity/tenant routing. Token expiry after registration preserves the existing grant and local queue; same-user renewal cannot extend the grant. Missing or invalid identity still revokes. This is a local binding to existing credentials, not a new server authentication protocol or an adopted company-wide Work consent policy.

The adapter binds task ID, canonical transcript path, file identity, cwd, device, principal, tenant and global consent state. It accepts the observed `source=vscode`, `originator=codex_work_desktop` top-level format. Other clients and subagents are not eligible. No history scan or implicit folder/org opt-in is added. A new selection revokes the previous one. Source replacement, identity changes, task-grant expiry, global OFF/ON and logout require fresh consent. Logout/terminal-license purge uses the existing retention path; retained payload age remains seven days. A busy deletion is recorded as pending and can finish through reconciliation.

Existing hooks route the selected task through the shared transcript delta queue and sanitizer. Stop re-reads records persisted after earlier callbacks. `reconcile` retries the exact selected file after restart or after late writes. Incomplete final records stay unread until complete; `pendingBytes`/`partial` report remaining bytes, including bounded batch backlog. A zero backlog is not a guarantee that the host will never append another record.

The startup selector preserves bounded originator identity. The companion pipeline candidate exports `agent=codex`, `originator=codex_work_desktop`, `surface=chatgpt_work`, without inferring execution location. Structured outer exec calls/results remain linked. Inner code-mode operations remain opaque after sanitization. Unknown records continue to produce explicit pipeline outcomes.

## Reproduce without live access

Run `npm run check` from this checkout. It checks version/manifests, 432 Node tests and 55 offline lifecycle scenarios. Eighteen new Work tests cover consent boundaries, delayed writes, restart/idempotence, path/task/cwd mismatches, source replacement, invalid metadata, revocation races, pending deletion, actual Stop-hook routing, no production sender, logout, global OFF/ON and retirement. Existing Codex/Claude sanitizer and auth regressions pass.

Run the new synthetic queue-to-parser check with Python 3.14:

```sh
python docs/work-capability/check_implementation.py --pipeline <Work-pipeline-checkout>
```

Expected: `passed: true`, three normalized messages, one linked outer tool pair, `delivery: disabled`. The source fixture is hand-authored and uses the observed outer record format. It is not copied from a private transcript. The older `check_compatibility.py` remains a historical characterization pinned to the pre-implementation pipeline; use `check_implementation.py` for this candidate.

The pipeline has 190 preprocessor tests, 318 analyzer tests and 322 synthesizer tests plus six subtests passing. Changed Python files pass Ruff and the preprocessor passes Pyright. Full report scoring is not validated by those consumer regressions.

## Candidate canary steps, not performed in this implementation run

1. Review the candidate diff and select/install this exact plugin in an isolated local canary configuration using the supported plugin workflow; review its hooks. The synthetic local canary can proceed independently of production consent discussions. Do not run the released uploader in parallel for the selected task.
2. Start a fresh local Work task using synthetic, non-sensitive content. Confirm the task's actual cwd and exact transcript metadata rather than assuming an attached folder changes cwd. Supply the exact local path and task ID to the candidate command below. This authorizes future bytes only.
3. Make one follow-up request with a known prompt, outer tool call/result and final answer. The candidate hooks should report `Work local: staged` or `unchanged`, with delivery disabled. Finish with explicit reconciliation after the answer is persisted.
4. Inspect the candidate local queue, normalize it with the Work pipeline branch and compare against the action ledger. Check identity, excluded pre-consent bytes, tool linkage, pending bytes, unknown formats and zero production upload calls. Run disable and verify bodies are removed. Save only sanitized/content-free evidence.
5. For a later real report canary, agree the non-repo consent contract, common credentials and approved candidate environment with Seungho/Homin; validate general-work analysis and user/tenant mapping before enabling any sender. Trace an explicitly approved real task through storage, normalization, analysis and the existing correct-user dashboard. None of these production actions is authorized or implemented by the local adapter.

Candidate command surface (run from this checkout; placeholders must be replaced with the selected task's values):

```sh
node plugins/skillmeter/scripts/work-local.js enable <exact-transcript-path> <task-id>
node plugins/skillmeter/scripts/work-local.js status
node plugins/skillmeter/scripts/work-local.js reconcile
node plugins/skillmeter/scripts/work-local.js disable
```

Registration/status output contains no token, transcript or raw path. The protected local selection journal necessarily retains the chosen path and task ID. No user must paste or upload a transcript. `reconcile` processes a bounded batch; repeat if pending bytes remain after the host has finished writing. It never scans for another task.

## Remaining limits

This is an experimental local adapter. Hook work is synchronous and uses the shared bounded staging read; large-session latency still needs a controlled measurement before broad rollout. The implementation has not been installed or live-tested after source changes. The earlier successful hook probe demonstrates runtime capability, not acceptance of this implementation.

The production non-repository consent policy, source fields at collector/dashboard boundaries, shared credential contract, delivery enablement and report suitability remain review gates. The developer-focused analyzer is unchanged. No cloud or ordinary ChatGPT chat capture, nested exec reconstruction, binary attachment extraction, history replay, release, merge, schedule or deployment was added.

Bases: plugin repair 8cb4a4d5fd763e4c4ff0681b9071ac864159cdb0, Work capability f288f8858dd5047925a703ed01efa0e97c5e14bf; pipeline repair fd5a75814e1622949d13eb54452251274aef5ac4. Remote mains observed before implementation: plugin 13b4648761aae7e9ebb20477276c13a416460173; pipeline f3d6710aa1ce4ca26fcb40c621ebf8bf618f34e1. Existing repair PRs and original dirty checkouts were left untouched. Both Work branches remain local, stacked on the repair candidates.

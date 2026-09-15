# Local ChatGPT Work: engineering review packet

Prepared September 16, 2026. Proposed scope, not an approved product policy or deployment request.

Extend the existing Codex plugin with an explicitly selected local Work task. Reuse its sanitizer, durable transcript queue, identity binding and the shared preprocessor. Keep Work delivery disabled until the credential/consent contract and report route are agreed. A separate plugin or a new cloud storage layout is not needed for this local experiment.

## What is verified

The two-turn desktop canary passed on plugin source/bridge `3022a12`; evidence checkpoint `aa21c9e`. It preserved totals 60/30, two user prompts and three linked outer tool pairs. All ten hooks succeeded; twelve contiguous sanitized chunks normalized into nine messages, with no pending bytes or actionable parser diagnostics. See [canary report](CANARY-PASS-20260916.md) and [content-free evidence](canary-pass-20260916.json). Temporary hooks and payloads were removed. Global telemetry stays ON; that does not enable general Work capture.

Read-only identity fix commit: `c80c3c998028ec17c1391a2d3e7b18b70a6345c9`.

The current review also reproduced an unintended credential write when Work status/enable called initializing device/salt getters. The follow-up source fix reads one existing credential snapshot and rejects incomplete identity without writing or migrating the shared file. Its regression failed before the fix and passes after. This source fix has not been installed or live-canary tested; the earlier canary remains evidence for its exact earlier revision.

The expiry probe is still a **known failing acceptance gate**: expiring the stored token after staging one consented chunk makes Work reconciliation return revoked and removes that chunk. The successful short canary did not exercise this. Current strict local behavior differs from ADR001's capture-during-expiry rule, so do not present Work as having full lifecycle parity. Run `node docs/work-capability/review-probes.cjs`; exit 1 currently means the expiry gap remains, not a broken test environment. The other probe confirms the credential-read fix.

## Decisions to settle

| Decision | Proposed default | Concrete response needed |
| --- | --- | --- |
| Non-repository consent | Explicit task selection, future bytes only, visible local-only status; no consent inferred from a folder or GitHub organization | Seungho/Homin: accept this scope and choose the supported user-facing selection/revocation flow. The marker bridge is test tooling, not a shipping UI. |
| Lifecycle | Continue capture within an existing valid task grant during token expiry, retain queued data, and require fresh authenticated delivery. Explicit logout/revocation still purge; grant expiry remains distinct from token expiry | Confirm the Work grant's duration/renewal behavior. Implement the demonstrated expiry correction against ADR001; don't solve it by silently refreshing/rebinding identity in the Work adapter. |
| Shared identity and credentials | Reuse the cross-client contract under INF-177 / INF-200; no Work-specific auth file, device ID or alternate token owner | Settle the existing #37/#38 lock, generation/device and broker-identity rules. Work must consume that contract, not create a competing writer. |
| Report route | First opt-in trial in an approved candidate environment; explicit user and tenant, supported Work source label, visible partial coverage | Name the environment and test account, confirm how its authenticated identity maps to the dashboard, and decide whether the developer-focused analyzer can accept this general-work sample. No secret needs to be pasted into this packet. |

Review these in the existing engineering issue context. No person has been assigned a new task by this packet and no response is assumed.

## Concrete implementation sequence after scope agreement

1. Replace the temporary marker bridge with the agreed selection/status/revocation entry point and verify native installed-plugin hooks in local Work. Preserve the one-task consent boundary and add long-session/returning-session checks; elapsed canary child times (111–174 ms) are only a small-task measurement.
2. Correct expiry retention and run the shared lifecycle contract, including logout, authoritative 402, identity change and mixed-client writes. Fresh-token validation remains a delivery requirement. Missing or corrupt identity must fail closed without writing credentials.
3. Add an explicit Work delivery path only after these contracts are settled. Reuse authenticated chunk transport and recheck task grant, principal/device/tenant at send time. Do not move Work bodies into the existing production queue as a shortcut. Preserve the shared S3 key shape and source discrimination unless engineering approves a broader migration.
4. In the approved environment, run the existing read-only object comparison from PR148 and validate Work parsing/partial coverage without suppressing valid Claude reports. Agree treatment of actual corruption across analyzer and synthesizer.
5. Trace one explicitly approved real Work session through stored sanitized chunks, shared normalization, an actual analyzer run and the existing dashboard for the intended user. Record receipts/report identifiers without copying transcript bodies. Only then discuss production enablement. Cloud and ordinary chat remain separate access/coverage work.

## Source navigation and branch state

Plugin Work branch `codex/work-capability-20260915` extends repair base `8cb4a4d5fd763e4c4ff0681b9071ac864159cdb0`. Review only the Work delta first:

```sh
git diff 8cb4a4d..HEAD -- plugins/skillmeter/scripts plugins/skillmeter/test/work-local.test.js plugins/skillmeter/test/work-runtime.test.js
```

The runtime changes are `scripts/lib/work-local.js`, `work-runtime.js`, `session-metadata.js`, `transcript-delta.js`, `queue-retention.js`, `scripts/logger.js` and `scripts/work-local.js`, with the two Work test files. The many files under this document directory are experimental fixtures, canary tools and historical checkpoints, not required product UI. Start with this packet rather than reading every dated checkpoint.

Pipeline Work branch `codex/work-normalization-20260915` is `32266389bdeaaef606924b3719d750c6e6ee46c9`, based on PR148 `fd5a75814e1622949d13eb54452251274aef5ac4`. Its delta is five shared-preprocessor modules (`model`, `codex`, `preprocess`, `structured`, `flatten`), `test_work_identity.py` and one document. It preserves `agent=codex`, `originator=codex_work_desktop`, `surface=chatgpt_work`; it does not infer execution host or reconstruct opaque inner commands.

Fresh remote checks: plugin main `13b4648761aae7e9ebb20477276c13a416460173`; pipeline main `f3d6710aa1ce4ca26fcb40c621ebf8bf618f34e1`. PR37 is open/draft at `8cb4a4d`; PR148 open/draft at `fd5a758`; Seungho's PR38 open/non-draft at `7bb34922`. Work branches are local and stacked, not independent main-ready changes. No remote branch/PR was changed in this review. Preserve the original dirty checkouts.

## Current engineering context

- [INF-177](https://linear.app/skillbench/issue/INF-177): backlog, assigned to Seungho. His September 14 comment recognizes Juho's Codex work and keeps the shared credential ADR open. It also reports that API Gateway verifies tokens while collector attribution trusts authorizer claims; locally decoding a token is not server identity verification.
- [INF-200](https://linear.app/skillbench/issue/INF-200): shared credential ownership remains open alongside the extension fix. Avoid representing one client's passing lock tests as cross-client agreement.
- [INF-210](https://linear.app/skillbench/issue/INF-210): done means a fresh Codex session reaches the right user's weekly report without damaging another agent's report. The Work local canary does not close it.
- [TEL-7](https://linear.app/skillbench/issue/TEL-7): closed September 15 because validation moved to INF-177. The closing comment is a tracking transfer, not evidence that multi-day Work validation passed.
- [PR148 discussion](https://github.com/SkillBench-AI/skillbench-pipelines/pull/148#issuecomment-5673631192): Juho's pending asks already cover corruption behavior, common credentials and approved existing-data comparison. The inspected PR has no later reply. Keep detailed Codex reconciliation there; attach the new Work scope discussion to INF-177 rather than implying PR148 already contains Work support.

There are two earlier suggested landing orders in the source discussions. Neither is an adopted deployment plan. Confirm one explicit rollout order after the shared contract and approved-object comparison; do not infer deployment authorization from this packet.

## Validation for this review

`npm run check` passed version/manifest validation, 449 Node tests (including canary bridge tests) and all 55 offline lifecycle scenarios. The focused Work/bridge run passed 35 overlapping tests; do not add that count to the full-suite total. The synthetic queue-to-parser check passed against pipeline `32266389`. No pipeline implementation changed in this review, so the earlier full Python suite counts remain historical evidence. The two additional readiness probes report one pass (read-only identity) and one unresolved gap (expiry); their nonzero exit is intentional until expiry handling is repaired. No production credentials, private transcript or real model request was used by these checks.

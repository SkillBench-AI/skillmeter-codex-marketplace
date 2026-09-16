# Work transcript resume repair, September 16, 2026

The Work adapter now accepts a replacement transcript file when the existing durable cursor proves that the committed prefix is unchanged and the task, account, device and consent still match. An inode change alone no longer revokes capture. This repairs the failure found after the user quit/reopened the app and the Mac restarted. The specific process that replaced the live file was not traced.

The adapter preserves the consent journal established at enable time instead of re-observing consent on every capture. This also prevents truncation of the same file from silently creating a new consent boundary. It reuses the existing chunk queue's prefix HMAC, snapshot generation and retirement logic. Pending-file selection supersedes older snapshot generations; the selected snapshot retains each message and structured tool pair once. Shared queue implementation, authentication, Claude code, pipeline source, consent duration and delivery behavior are unchanged.

Continuity requires a committed cursor from the current grant; a retained cursor from a revoked grant cannot establish continuity for a new grant. Replacement before the first commit is conservatively rejected and requires fresh consent. Same-file and replacement-file corruption/truncation revoke and purge. Changed task metadata/account/device/policy, disabled or mismatched consent journals, symlinks and expired grants remain denied. Restart does not renew the grant, restore revoked consent, include pre-consent/paused history or reconstruct retired bodies.

## Validation

Five new regression cases failed against the prior source before the repair. The focused Work adapter tests then passed. A fresh-process SessionStart/Stop test exercises actual candidate handlers across replacement with network/subprocess access blocked, pre-existing sign-in marker, unchanged synthetic credentials/policy, and an empty production upload queue. This is deterministic handler validation, not desktop dispatch evidence. Initial runtime fixture failure came from the existing SessionStart sign-in-marker migration; the final fixture explicitly starts with an established sign-in. No authentication implementation was changed.

The synthetic queue-to-preprocessor bridge now places file replacement between a tool call and its result. The candidate pipeline produces three messages and one matched outer exec tool pair, preserves Work source identity, reports no actionable or incomplete-tool diagnostics, and excludes historical/opaque-command sentinels. The earlier expiry-retention and read-only credential probes also pass. All test data is synthetic; no private transcript or credential was copied.

Validation: the complete npm run check gate passes:466 Node tests,55 offline lifecycle scenarios, version and manifest checks. The focused suites overlap with these counts and must not be added. The queue-to-preprocessor bridge and both review probes pass separately. Test logs are outside Git under reports/chatgpt-work-canary-20260915/resume-*.log.

## Remaining live validation

The temporary native plugin remains uninstalled and its control disabled. This source fix has not been installed or live-tested. The earlier native canary remains a partial result; its deleted queue has not been reconstructed.

Prepare a new guarded package from this repair commit and a fresh synthetic local Work task with explicit consent. Verify the first turn and reconcile its final tail. Quit/reopen the app, continue that same task, and verify native SessionStart plus complete latest-snapshot normalization without duplicates. Then test a machine restart separately, continuing the same grant only if it is still valid. Compare source/tool links and pre-consent exclusion, then disable/purge/uninstall the temporary package. Follow the queue's pendingFiles/latest-baseline selection rather than concatenating every retained gzip across snapshot generations. Do not reuse historical consent or extend its expiry silently.

Production gates remain: consent/shared-credential contract, approved environment and user/report mapping, Work analyzer eligibility/rubric, authenticated delivery and one approved real session reaching the existing correct-user dashboard. No remote push, PR update, installation, deployment or production send is part of this source repair.

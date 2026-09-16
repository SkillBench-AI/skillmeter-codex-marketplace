# Native Work canary: resume gap, September 16, 2026

Result: partial. First-turn native capture passed. The follow-up ran in the correct selected task, produced the expected30/60, and left memo.md unchanged. Native dispatch worked for all43 callbacks. On resumed SessionStart, however, capture returned revoked; the four subsequent callbacks returned not-enabled. The previous36 queued chunks were purged and the follow-up was not staged. No combined two-turn normalization result is claimed.

## Cause and evidence

The selected transcript retained its exact previously committed976360-byte prefix, verified against the cursor HMAC. It had63523 new bytes, but a different filesystem identity. The selected task/cwd/source/originator, account, device and consent policy still matched; the grant had not expired. The Work adapter's source fileId check rejects replacements before the durable queue can inspect prefix continuity. A synthetic atomic replacement with the exact original prefix plus one new message reproduces staged -> revoked and removal of all pending chunks. Evidence: final-evidence.json and resume-reproduction.json. The process responsible for replacing the file was not independently traced; replacement was observed across desktop task resume.

The first-turn evidence remains valid historical evidence:38 native callbacks,36 chunks after reconciliation,20 normalized messages and15 matched outer tool pairs. The selected raw source now has two user prompts and16 outer tool call/result pairs. Counts from the source are not proof of capture of the second turn. No raw transcript body or credential was copied into these documents.

## Cleanup completed

Disabled the isolated capture, verified no queued payloads or pending purge, cleared and expired the native control, and uninstalled only skillmeter-work-canary@personal through the supported CLI. Its installed cache is gone. Normal SkillMeter manifest/hooks, shared credentials and telemetry policy were byte-identical before and after cleanup. Global telemetry remains ON, no user-hook bridge exists, and the isolated candidate production queue was empty. The local source package/listing is retained for later reproduction. The original application transcript is untouched. No live send, production analyzer/dashboard run, remote push, PR update or engineering message occurred.

## First next action

Add an automated failing regression for exact-prefix file replacement on Work resume, then repair the adapter using the durable queue's existing content-integrity and consent rules. Validate legitimate replacement, same-file and replacement-file corruption, truncation, changed metadata/identity, restart, exclusion of pre-consent content, and duplicate handling across snapshot generations. Do not merely remove fileId validation or silently re-enable revoked consent. The shared queue already has replacement/prefix behavior; evaluate it before introducing another cursor mechanism. Preserve existing account/consent revocation and Claude behavior.

After the source fix and deterministic checks, prepare a fresh native package and run a fresh explicitly consented two-turn task, including an actual close/reopen or resume boundary. Do not recapture the purged task or reinterpret manual normalization as native success. No more manual action is needed from the user until that repair is ready.

Production gates remain unchanged: shared credential/consent agreement, approved environment and user/report mapping, Work analyzer eligibility/rubric, authenticated Work delivery, and one approved real session reaching the correct existing dashboard. Guarded native packaging still differs from the full release manifest. Cloud and ordinary chat remain unsupported.

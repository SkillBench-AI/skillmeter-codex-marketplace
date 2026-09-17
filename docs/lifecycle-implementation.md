# ADR001 implementation checkpoint, 2026-09-14

Historical checkpoint. The September 18 reconciliation preserves this lifecycle
behavior while incorporating main's credential writer lock and device-aware
snapshots. Claude's later broker cutover is not implemented here; see
`credential-reconciliation.md` and the current draft PR status.

M1 implements the previously failing 34-case acceptance contract. The local
acceptance suite now passes 34/34 and `npm run check` passes 413/413. The prior
red baseline remains in `lifecycle-baseline.json` as historical evidence.

The implementation follows Claude main `0ea5137` (verified unchanged today):
typed refresh outcomes, the byte-identical `license-status.js` schema and
backoff functions, expiry-independent capture and authenticated delivery, and
bounded removal of unsent Codex payloads. Codex uses its existing durable PID
lock for refresh coordination, scoped to the shared state directory.

Claude A4 has not landed at this pin. Codex adds `prior_signin` (github_id,
sub or null, org.login and aud) and `auth_generation` to the existing credential
object. Existing fields remain unchanged. Recovery checks the current GitHub
ID before activation, compares minted claims before committing, and checks the
original credential snapshot against intervening sign-in/sign-out. These
additive fields and Codex's credential lock need coordination with the other
client's eventual A4 writer; current Claude does not participate in this lock.

Retirement writes a byte exclusion marker before deleting transcript bodies.
The cursor and consent journal remain so a missing-baseline reset cannot
silently reconstruct retired history. Failed or busy purge work remains
durable; a damaged source journal stays blocked while healthy queues continue.
Existing tests were updated only where the accepted contract changed: realistic
identity-bearing refresh fixtures and deletion instead of quarantine after the
retention limit.

M2 completes explicit sign-in generation checks, 402 purge in both activation
paths, terminal user notices, SessionStart/sign-in reset, refresh cooldown and
one-shot drain recovery. Retirement tests cover busy locks, interrupted deletion,
missing cursors, invalid journals, legacy snapshots and baseline reconstruction.
The hook hot path checks only pending purge intent; background work scans age.

Final evidence: 414 regular tests and 55 lifecycle checks pass. The lifecycle
suite is now required by `npm run check` and both Node versions in GitHub CI.
The existing synthetic cross-repository contract passes with 40 records and 21
messages; it uses a scripted analyzer response and does not reach the dashboard.

No candidate installation or shared live credential mutation was performed.
PR #37 stays draft. The remaining cross-client writer review and exact live
canary steps are recorded in `lifecycle-checkpoint.md`. No production deployment,
merge, release, schedule change or historical replay occurred.

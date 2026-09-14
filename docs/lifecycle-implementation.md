# ADR001 implementation checkpoint, 2026-09-14

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

M2 remains in progress: explicit sign-in paths, user-visible status, fault/race
tests, retirement recovery tests and review of compatibility limits. This is a
local source checkpoint, not permission to install the candidate into a user's
shared runtime. PR #37 stays draft; no production deployment, merge or release.
The scoped live-canary steps remain in `lifecycle-checkpoint.md`.

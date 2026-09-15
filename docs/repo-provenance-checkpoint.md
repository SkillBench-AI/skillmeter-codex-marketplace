# Repository provenance checkpoint, 2026-09-14

Candidate branch: `codex/consent-queue-parity-20260913`, PR #37 remains draft.
Commit: `54ce356` (base `8d9e51d`). Claude reference: 0.34.1 at
`0ea513751149a23fcc063fb8f045794657ceb031`.

The real Codex stdin hook now derives `repo_name` after consent/scope checks.
Authoritative metadata overrides hook-specific fields. Sanitizer behavior is
unchanged. Targeted tests reproduced spoofed/missing repository identity before
the fix and pass afterward. `npm run check`: 413 passed, zero failures/skips.

Next: add a strict synthetic ADR001 acceptance harness. Known gaps include
expired-token capture, recovery identity binding, transient refresh handling,
logout/revocation purge and seven-day retention. Green regression tests do not
establish ADR001 compliance. No shared credentials or historical canaries changed.

Live release still requires a scoped development identity, the reviewed
collector/parser candidates deployed to the selected development tenant, and a
real Codex session processed by the existing analyzer into the correct user's
dashboard. The prior local canary used plugin `8d9e51d` and does not validate this
new revision. No production deployment, merge or release is authorized here.

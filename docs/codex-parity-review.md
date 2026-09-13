# Author review, September 13, 2026

Reviewed against remote transport base `84f48f3`, using the GStack review
checklist. No agents or independent reviewer were used. The existing transport,
parser and collector PRs remain draft. This review does not authorize release.

Fixed findings:

- Delivery read one token and checked queue ownership against another refreshed
  token. `scopeStillAllowed(scope, requestToken)` now checks the exact request
  principal. A reproduced failing race fixture now blocks the wrong-principal
  request with zero sends.
- Consent could change between journal observation and staging. A final commit
  authorization guard now rejects publication without advancing the cursor.
- Explicit disable could return early on legacy local OFF without disabling
  other clones. Idempotence now checks the canonical repository record.
- Event drains lacked serialization and quarantined payloads lost repository
  separation. Each sealed batch has a delivery lock and repository-local poison
  storage, removed when that repository is revoked.
- Unsupported shared policy versions could be normalized and overwritten. The
  Codex adapter rejects them for reads and mutations without changing the file.

Evidence: `consent-parity.test.js`, `transcript-delta.test.js`,
`sanitizer-parity.test.js`, copied Claude tests/corpora and the independent
Python record/canonical oracle. Final local check: 401 passed. The old tests were
updated for deliberate policy contracts, not disabled: metadata uses secrets/PII
and ids, malformed local export now errors, and a short invalid fake PAT uses the
shared 82-character fixture. Commands/patches remain hashes; the analyzer fixture
therefore has no path-derived tech-stack refinement call. Its scripted responses
are aligned to that observed call sequence, all consumed, and the report must
validate with the existing schema.

Open release gates (confirmed, not speculative test failures):

- First-observation exclusions can omit opening source records. Installed Codex
  hook timing and full authorized-session coverage need verification.
- Unobserved expired/signout intervals require the eventual ADR001 lifecycle
  contract. Original dirty sign-in/auth changes are preserved but not fully
  reconciled; only the licensed-org reader was incorporated.
- Queue authorization still uses its first checkout as a validation hint.
  Removing that checkout can block delivery until recovery is designed.
- Per-file cross-repository consent remains the separate INF-195 contract.
- The shared Claude policy writer retains its timestamp-based lock protocol.
- These are source tests on macOS. Cross-version Linux CI and installed-client
  setup/upgrade/rollback, real auth, model, backend and dashboard remain gates.

No new service, package release, version bump, deployment, shared auth config,
schedule or history replay is included. See the checkpoint for the live sequence.

Final shared-state fix: an explicit Codex global toggle now retires the legacy
credentials OFF flag and writes the shared policy only. A Claude policy resume
therefore resumes Codex too. Pre-existing legacy OFF remains respected until an
explicit toggle or migration. The cross-client regression and CLI assertions pass.

# Credential reconciliation for PRs 37 and 38

Updated September 18, 2026: #35/#38 are merged into main. This draft now
incorporates their transcript fixes, credential writer lock, device-aware
snapshots and ingest-rejection refresh trigger while retaining #37's consent,
identity and retention checks. The five synthetic contract probes pass on the
combined working tree. This does not establish cross-client broker compatibility.

Still pending: Homin's broker-auth alignment, a common lock protocol across
clients, token/generation-bound rejection bookkeeping, and installed-client /
live validation. The comparisons and receipts below describe September 15
revisions, not the current draft.

## Exact comparison and evidence

Compared candidate #37 at `b22d9f0dd3143a58c13cb9276ceb3e9be0790b0c`
with Seungho's #38 at `7bb34922eafed0436beb8903ecc3c3a684103547`,
against fetched main `13b4648`. #37 includes the earlier transport work from
#35. #38 has nine changed files relative to main; a whole-tree replacement of
#37 with #38 would discard the larger transport, consent and sanitizer work.

Both checkouts pass their own `npm run check`: #37 has 414 Node tests plus 55
offline lifecycle cases; #38 has 209 Node tests. These are different suites,
not evidence that the branches are equivalent or safe to merge automatically.

The same synthetic contract probes were also run against both checkouts:

| Required behavior under review | #37 | #38 |
| --- | --- | --- |
| A changed device invalidates an old refresh commit | Gap | Pass |
| A changed GitHub identity requires sign-in rather than silent replacement | Pass | Gap |
| A new auth generation invalidates an old refresh commit | Pass | Pass |
| Sign-out invalidates an old refresh commit | Pass | Pass |
| A credential setter respects another writer's held lock | Gap | Pass |

The identity row uses the existing GitHub-issued token shape. The broker token
shape and dashboard mapping still need the account owners' decision. These
probes measure conditional commit behavior, not issuer/signature verification
or complete HTTP recovery behavior. The collector remains the verifier.

Reproduce with Node 20+ from this candidate checkout:

```sh
node plugins/skillmeter/integration/credential_contract.cjs /path/to/pr37-checkout
node plugins/skillmeter/integration/credential_contract.cjs /path/to/pr38-checkout
```

The probes create and remove synthetic temporary homes, block network and
Keychain/gh access, and output names/outcomes only. Exit 1 is expected while
contract gaps remain; exit 2 inside a probe is reported as `error`. They are
kept outside the default passing regression suite. See the committed
`credential-contract-pr37.json` and `credential-contract-pr38.json` receipts.
Use clean, trusted checkouts at the recorded revisions for reproduction.

## Reconcile by behavior

| Area | #37 behavior to preserve | #38 contribution or remaining difference |
| --- | --- | --- |
| Credential mutations | Atomic file replacement; auth generation and prior-sign-in marker checked under a lock | All setters and migrations use a fresh locked read/modify/write; #37 still has direct writers. Port the discipline across all write paths, including missing-device/salt migration. |
| In-flight recovery | Token/generation/consented identity checks and rejection of superseded responses | Add device ID to snapshots and conditional commits. Preserve #37's prior marker check as well. |
| Lock ownership | PID lock and no time-based takeover of a live holder | #38 adds owner tokens, bounded waiting, pre-write ownership/raw-state checks and 60-second age recovery. Agree the age-recovery rule before selecting the common lock implementation. |
| Delivery | Fresh credentials and audience checks, consent recheck and tenant ownership for both queue types | #38 also uses fresh credentials for upload and retains credentials on upload rejection. Preserve all consent and destination checks while reconciling logger.js. |
| Unexpired token rejected by ingest | Current #37 refresh short-circuit waits for expiry; this is an uncovered recovery gap | #38 persists `.license-rejected` to force refresh. Its marker is not token/generation-bound. Bind a reconciled marker to the rejected credential so late responses cannot force or clear recovery for a newer sign-in. |
| Refresh failures | Typed outcomes: only token absence or 401/410 permits identity-bound gh recovery; transient failures retain token and back off | #38 collapses failures to null and permits broad gh fallback. Preserve #37's ADR001 decision-2 handling. |
| Missing token | Prior sign-in and current gh identity required; explicit sign-out blocks recovery | Preserve #37's decision-4 marker and mismatch handling rather than replacing with a bare current-file check. |
| Capture and retention | Expired tokens can still capture within consent; authenticated send; logout and refresh/activate 402 purge; 7-day retention | Keep #37's lifecycle implementation and tests. #38's narrower changes do not implement the complete ADR001 lifecycle. |
| User/operator status | Persistent backoff/terminal reasons and restart behavior | Keep #37's license-status module and notices. Preserve separate drain/refresh state. |
| Transport | Durable cursor, chunk sequence/reset, structured transcript records, source metadata | Keep #35/#37 transport and collector contract tests. Auth fixes alone do not repair the legacy snapshot protocol. |
| Sanitization/consent | Pinned Claude 0.34.1 policy 3.1.0 modules/corpora, shared repo consent, consented repo_name | #38 is based on main's earlier sanitizer. Do not replace the #37 sanitizer or queue layout during conflict resolution. |

Lock review detail: #38's token-based ownership check fixes inode reuse, and its
tests demonstrate a preempted mutation retrying against newer state. Its age
backstop can also evict a live suspended process. The ownership/raw-file checks
occur before `writeStore`, not atomically with rename, so they alone cannot
prove exclusion if a process pauses after the check. This is a code-review risk,
not a reproduced production incident. #37's no-age approach instead risks a
stuck lock after PID reuse or an unreadable owner. Agree the tradeoff and test
the chosen protocol across clients; do not describe either as a universal fix.

## Proposed common credential contract

Seungho should review these rules with the client owners. Existing ADR001
decisions remain the reference; the shared-file additions below are proposals.

- Keep device ID and hashing salt stable across clients and sign-out. Preserve
  fields owned by other clients during every mutation. No migration may restore
  a credential after a newer sign-out.
- All writers must use the same atomic read/modify/write and lock protocol,
  including initialization, legacy migration, token rotation, telemetry toggles,
  sign-in and sign-out. Atomic rename alone is not cross-process serialization.
  Define the lock location/owner format, waiting limit, recovery rule and how
  mixed old/new client versions behave during rollout.
- Snapshot token, device ID, generation, sign-out state and consented identity
  before a network exchange. Commit only if that state is still current.
  Explicit sign-in/sign-out changes generation even when the JWT is reused.
- Refresh may rotate a token within the consented identity. Silent activation
  requires a prior sign-in and matching current identity. Confirm the canonical
  identity fields for GitHub-issued and broker-issued tokens; a client must not
  delete the shared credential merely because its local issuer assumptions differ.
- Separate local expiry, ingest rejection and authoritative revocation.
  Ingest 401/403 requests bounded recovery without deleting another client's
  token. Define handling of ingest 402 separately; ADR001's purge rule names
  402 from refresh/activate. Bind rejection/success bookkeeping to the token
  and generation used by the request.
- Keep ADR001 capture, transient retry, terminal status, explicit logout,
  revocation purge and seven-day retention semantics. Define which queues each
  client purges and how the others observe a shared sign-out. A Codex-only
  purge is not proof that Claude/VS Code queues were removed.
- Derive the delivery audience and bearer from the same fresh credential
  snapshot, retain repository/tenant ownership of queued items and recheck
  consent at send time. Never relabel an old queue for a newly signed-in tenant.

## ADR and landing checklist

- [x] Compare exact #37/#38 changes and execute both existing suites.
- [x] Add shared synthetic probes with explicit gaps rather than equating two
  green suites with compatibility.
- [x] Map Codex to ADR001 decisions 2–4 and ADR002 stage-1 policy 3.1.0 using
  the pinned Claude source and existing tests.
- [x] Port #38's credential writer lock and device-aware snapshots into the
  combined candidate; preserve identity checks and test stale commits.
- [ ] Agree the cross-client lock protocol and bind rejection bookkeeping to
  the token/generation used by each request.
- [x] Validate the combined candidate: 449 Node tests, 55 offline lifecycle
  cases and five credential contract probes pass. Race tests retain account /
  device / generation protections under the lifecycle API and single-flight lock.
- [ ] Confirm canonical GitHub/broker identity fields, issuer/audience handling
  and the target dashboard user with Seungho/Homin (INF-200, INF-177, DAS-301).
- [ ] Verify Claude and VS Code implement the agreed shared mutation protocol.
  The pinned Claude 0.34.1 credstore uses atomic writes without this Codex lock;
  this audit does not claim either client passes the new contract.
- [ ] Finalize #37's release scope/version (0.6.0 proposed). Main is now 0.5.0;
  this draft inherits that version until its own release change. Marketplace
  main is a release channel, so keep this unfinished candidate draft.
- [ ] Confirm stage-2 rollout status with its owner. ADR002's stage-2 engine and
  measurement/gating work is separate; stage-1 parity does not establish it.
- [ ] Run the approved same-object pipeline comparison, then one fresh scoped
  Codex session through candidate collector, normalizer, analysis and the
  correct existing dashboard user. Record receipt/report evidence without
  copying a private transcript into the handoff.

Suggested engineering questions, not sent: Can we adopt the combined writer and
snapshot contract above, including device identity and the prior-sign-in marker?
Which stale-lock recovery rule should all three clients use? Which broker claims
identify the same consenting user/tenant, and who owns the dashboard mapping?
After those are settled, what is the approved service-deploy/plugin-release order?

Sources: [PR38](https://github.com/SkillBench-AI/skillmeter-codex-marketplace/pull/38),
[PR37](https://github.com/SkillBench-AI/skillmeter-codex-marketplace/pull/37),
[INF-210](https://linear.app/skillbench/issue/INF-210),
[INF-177](https://linear.app/skillbench/issue/INF-177),
[INF-200](https://linear.app/skillbench/issue/INF-200),
[DAS-301](https://linear.app/skillbench/issue/DAS-301).
Claude reference: `0ea513751149a23fcc063fb8f045794657ceb031`,
`docs/adr/001-license-token-lifecycle.md`, `docs/adr/002-two-stage-sanitization.md`
and `skillmeter/scripts/credstore.js`. See `claude-parity.md` for copied-module
hashes and `lifecycle-implementation.md` for existing offline acceptance evidence.

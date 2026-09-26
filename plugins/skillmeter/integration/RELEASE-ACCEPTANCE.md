# Upgrade release acceptance

Use this procedure for a specific set of client and backend revisions. Passing
queue tests alone does not establish shared consent, deployment or native-host
compatibility. A version is supported only for the tested combination; adding a
fixture does not promise indefinite support or safe downgrade.

## Evidence before release

Record full producer, Claude, collector and reader commit SHAs. Run:

```sh
npm run check
node plugins/skillmeter/integration/check_mixed_auth.cjs /path/to/claude
python -B plugins/skillmeter/integration/candidate_contract.py pin \
  --collector /path/to/collector --pipeline /path/to/pipeline \
  --manifest /protected/candidate.json
python -B plugins/skillmeter/integration/candidate_contract.py run \
  --collector /path/to/collector --pipeline /path/to/pipeline \
  --manifest /protected/candidate.json --out /protected/result.json \
  --python /path/to/pipeline/.venv/bin/python --go /path/to/go
```

Keep evidence outside clean checkouts. Retain failures as well as successes and
rerun when any revision changes. Mixed-client checks require the Claude checkout
to be clean and exercise actual credential and policy writers against intercepted
Codex delivery. They test sequential interleavings, not atomic coordination
between concurrent credential writers. Existing published clients cannot gain new
format guards or consent semantics through a change to the candidate.

| Boundary | Required evidence |
| --- | --- |
| Released queues and identity | Pinned release fixtures, retry byte equality, monotonic cursor/sequence, stable owner/device/salt |
| Authentication | Sign-out and expiry hold queues; rejected authentication never clears shared identity or causes anonymous retry; stale refresh cannot undo sign-out |
| Consent | Pause holds; explicit repository OFF purges without delivery; re-enable does not resurrect revoked work; sign-in does not clear shared pause |
| Migration | No grant inferred from timestamps/current ON; source/cursor-bound plans; both interruption points recover; excluded history remains excluded |
| Client/backend protocol | Exact-revision collector/reader contract, duplicate retries, continuation and missing-baseline recovery |
| Installed host | Actual hook and detached worker use the same persistent directory after replacement/restart |

The mixed-client gate deliberately fails when a candidate ignores another
client's pause or OFF. Compose the necessary shared-policy fixes and test again;
do not reinterpret that failure as an optional warning. Additional host clients
and unsupported format versions need their own tests before admission.

## Hosted checks

`.github/workflows/compatibility.yml` is a manual/reusable integration workflow.
It accepts full reviewed Claude, collector and pipeline SHAs; the producer is the
workflow's selected revision. It installs the Python lockfile and prepares Go
modules before the offline runner. It retains only content-free receipts.

An administrator must provision `COMPATIBILITY_READ_TOKEN` with `contents: read`
for the private collector and pipeline repositories. Prefer a narrowly scoped,
expiring credential; do not copy a developer token or runtime AWS/model secrets.
Checkout credentials are removed before tests. This workflow does not run with
secrets on pull requests or `pull_request_target`.

After a successful hosted run, make the compatibility job a required release
prerequisite in the caller/ruleset. Test a deliberately incompatible combination
and confirm publication is blocked. Until access, caller wiring and required
checks are configured and exercised, this is workflow code, not an enforced
release gate. The existing release workflow's full-history checkout is required
for historical fixtures, but does not by itself enforce the cross-repository gate.

## Deployment and cutover

1. Obtain independent review of the complete composition, including shared consent
   dependencies and migration. Record the exact reviewed SHAs and green receipts.
2. Deploy the compatible reader first, then collector. An authorized operator
   verifies running revisions and a synthetic canary through the live path. A
   repository SHA or successful build is not proof of the running deployment.
3. Finish active turns and stop old hooks/drainers. Do not toggle consent OFF/ON
   to pause writers: revocation can purge queues and change authorization.
4. Make a protected, consistent backup of persistent queues, source prefixes,
   credential identity and relevant settings. Verify backup hashes and a restore
   in isolation. Keep secrets/transcripts out of Git, CI artifacts and logs.
   Copies made while writers run are rehearsal snapshots, not cutover backups.
5. Reconcile pending chunks and reset requests before legacy migration. Produce
   fresh source/cursor-bound plans and obtain approval for exact historical
   ranges. Timestamp inventories and a full-history simulation are not grants.
   Compacted history needs review even when its outer timestamp is recent.
6. Install the reviewed client with the same persistent data directory. Apply
   only the approved plans while writers remain stopped. Verify receipts and
   preserved offset, generation, baseline, sequence, owner, device and salt.
7. Restart one client and run a small authorized canary. Verify hook invocation,
   detached-worker path, queue advancement, collector acknowledgement and reader
   reconstruction. Exercise pause/OFF on a dedicated synthetic repository.
   Check content/identity, not merely EOF or HTTP 2xx, before resuming other work.

Stop on any changed source/cursor/authorization, unrecognized format, unknown
runtime revision, stranded directory, wrong owner or unexpected record. Keep the
queues and diagnostics intact. A consent-limited reset can legitimately require
separate recovery; never widen a grant merely to make a test or migration pass.

## Recovery and rollback

Before any new external acknowledgement, restore a frozen backup only while all
writers are stopped and after checking that its source bindings still match.
Source copies have different paths/inodes and require explicit rebinding in an
isolated rehearsal; a successful rebound copy is not an in-place rollback proof.

After new data has been acknowledged externally, restoring an older cursor alone
can replay work or conflict with newer server state. Preserve both snapshots and
reconcile them with the compatible collector/reader. Prefer a forward fix; never
run an older writer or cleanup tool against migrated state without a tested
reverse migration. Retention and deletion rules still apply to held data.

Weekly-report selection, analysis quality and report completeness are separate
acceptance work and are not certified by this procedure.

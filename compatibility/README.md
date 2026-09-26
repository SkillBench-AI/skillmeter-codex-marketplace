# Compatibility contract

`contract.json` describes the candidate harness's required coverage. It is not
an approved support window or a production compatibility certificate. The
canonical shared policy remains Claude ADR 005; this file records executable
Codex coverage without changing that policy.

The release queue and authentication suites consume `upgradePaths` directly.
The mixed-client gate consumes `requiredCases.mixedAuth`. Validation rejects
unknown schemas, empty or duplicate matrices, floating pins, missing recovery
paths, omitted cases and unimplemented scenarios. Adding a scenario requires its
implementation and a validator update; removing a required scenario cannot
silently reduce coverage through a JSON-only edit. Release-path retirement still
requires the explicit engineering review described below.

A legacy cursor without a consent journal requires an explicit range-bound
migration. A journal-bearing cursor follows the existing journal. Neither path
approves real historical ranges. Unknown upgrades and untested downgrades remain
blocked by the contract; runtime enforcement is separately implemented and
verified. Declaring a matrix entry does not patch an older installed client.

Run the current contract and ordinary suites:

```sh
npm run check
```

## Final candidate gate

`.github/scripts/compatibility-gate.cjs` combines the mixed-client and backend
and runtime-fault receipts. The caller writes `expected-candidate.json` before starting tests:

```json
{
  "version": 1,
  "startedAt": "2026-01-01T00:00:00Z",
  "revisions": {
    "producer": "FULL_REVIEWED_SHA",
    "claude": "FULL_REVIEWED_SHA",
    "collector": "FULL_REVIEWED_SHA",
    "pipeline": "FULL_REVIEWED_SHA"
  }
}
```

Use the actual invocation time and full lowercase commit SHAs, not these
placeholders. Generate this context in trusted orchestration, not from a PR's
claimed test result. The hosted workflow does so after validating the producer checkout and before
checking out dependencies or starting tests.

```sh
node .github/scripts/compatibility-gate.cjs \
  /protected/expected-candidate.json /protected/mixed-auth.json \
  /protected/candidate-result.json /protected/runtime-faults.json \
  /protected/compatibility-acceptance.json
```

The output must be outside the checkout and distinct from all inputs. The gate
checks a clean producer checkout, exact revisions, the contract digest, complete
case/stage evidence, backend record counts and evidence times within the current
invocation. Invocations expire after one hour. Missing, failed, skipped, duplicate,
stale or mismatched evidence fails. A previous success is replaced before input
processing. Nonzero process exit must block the calling job even if another
artifact says pass.

Receipts are content-free audit evidence, not cryptographic attestations. They
must come from trusted jobs executing reviewed code with constrained checkout
access. Do not accept user-supplied receipt JSON as authorization to ship. The
result certifies only this synthetic candidate composition; it does not prove
production deployment, native-host behavior or report completeness.

## Shipping enforcement and maintenance

The marketplace serves `main`; tags publish separate releases. The shipping
workflow admits PRs to the merge queue using public checks, then runs private
compatibility tests on the queue's exact combined commit. The Release workflow
runs fresh compatibility tests on main before requesting publication credentials.
Dependency revisions come from reviewed `dependencies.json`, never caller inputs.
These candidate pins describe tested code, not deployed backend versions.

[Shipping gate setup](SHIPPING.md) defines the required merge queue, status
checks, protected environments, tag restrictions and hosted acceptance tests.
Workflow files alone do not enforce repository settings. In particular, the
PR's `Compatibility required` success means queue admission only. It is safe
only when direct merging is prohibited by the required merge queue rule.

Version additions or retirements need engineering review of the supported
population, server combinations and recovery path. Support-window and maintainer
assignments remain explicit product/engineering decisions. Extend immutable
release fixtures and negative tests with every newly claimed path. Review
simultaneous writers and partial client updates before claiming those combinations.

Mixed authorization checks also run isolated Node processes sharing synthetic
credentials. IPC barriers hold refresh responses across sign-out/sign-in and
force lock contention in both client directions. The gate checks identity
creation, recovery after a writer dies between temp-file fsync and rename, and a surviving process
from each pinned Codex release interacting with the candidate Claude client.
Queue and policy fixtures must remain byte-identical in these auth-only cases.
Four additional cases age live credential writers and releasers, pause a dead
owner's cleanup, kill that cleanup process, and repeat through directory aliases.
Live owners retain their locks; confirmed-dead owners can be reclaimed without
letting an obsolete cleanup remove a replacement lock.

The guarantee requires both plugins to use the dead-owner-only protocol, on
one host with a local filesystem. Older processes must exit after both plugins
are updated; released clients with age-based takeover can still break exclusion.
The surviving-release cases prove only the named auth transitions. They do not
establish native host reload behavior or unrestricted mixed-version locking.

Unknown, malformed or unverifiable ownership holds credential writes, even if
the lock is old. PID reuse and repeated cleanup crashes may require recovery
with all writers stopped. Do not delete a live lock to resolve contention.

Broker cases use Claude's real credential writer without supplying a synthetic
Codex organization list. Failed broker refresh preserves the credential and
cannot fall back to GitHub activation, following Claude ADR 001's broker
amendment. Successful refresh narrows existing Codex scope to the new license.
Missing, empty or malformed plural organization claims hold that scope;
`org.login` is a broker tenant slug and cannot authorize a GitHub repository. A fresh
broker sign-in without an existing Codex scope remains held; these tests do not
claim full broker onboarding support or authorize collection.

## Deliberate runtime faults

Run the mutation gate with the pipeline's Python environment:

```sh
python -B plugins/skillmeter/integration/runtime_faults.py \
  --pipeline /checkouts/pipeline --python /checkouts/pipeline/.venv/bin/python \
  --out /protected/runtime-faults.json
```

It archives the clean pinned producer and reader into temporary directories.
The same independent oracle runs before and after each source mutation: advance
a migration cursor past approved backlog, bypass excluded consent ranges, and
remove Codex format recognition from the reader. The pristine copy must pass,
and the mutated copy must produce the named semantic violation. A timeout,
syntax error, import failure, unexpected result or unchanged mutation cannot
count as successful detection. Source anchors must match once; source changes
that invalidate a mutation require a reviewed fixture update.

The final candidate gate requires all three results, fresh timestamps, the
contract digest and matching producer/reader revisions. Private reader code is
used only in the trusted cross-repository job. Public CI exercises producer
faults and runner rejection behavior without private checkout access. These
representative mutations prove the named checks are sensitive; they do not
prove detection of every possible incompatibility or native host behavior.

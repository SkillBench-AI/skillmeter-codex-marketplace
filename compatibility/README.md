# Compatibility contract

`contract.json` describes the candidate harness's required coverage. It is not
an approved support window or a production compatibility certificate. The
canonical shared policy remains Claude ADR 005; this file records executable
Codex coverage without changing that policy.

The release queue and authentication suites consume `upgradePaths` directly.
The mixed-client gate consumes `requiredCases.mixedAuth`. Validation rejects
unknown schemas, empty or duplicate matrices, floating pins, missing recovery
paths, omitted cases and unimplemented scenarios. Adding a scenario requires its
implementation and a validator update; deleting a requirement cannot silently
reduce coverage through a JSON-only edit.

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
receipts. The caller writes `expected-candidate.json` before starting tests:

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
claimed test result. The hosted workflow does so before checkout and testing.

```sh
node .github/scripts/compatibility-gate.cjs \
  /protected/expected-candidate.json /protected/mixed-auth.json \
  /protected/candidate-result.json /protected/compatibility-acceptance.json
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

Both distribution paths matter: the marketplace serves `main`; tags publish
separate releases. The final gate is wired into the proposed reusable workflow,
but private checkout access, trusted pre-merge orchestration, required repository
checks and release-caller wiring still require deployment and verification.
A successful manual run alone is not an enforced shipping gate.

Version additions or retirements need engineering review of the supported
population, server combinations and recovery path. Support-window and maintainer
assignments remain explicit product/engineering decisions. Extend immutable
release fixtures and negative tests with every newly claimed path. Review
simultaneous writers and partial client updates before claiming those combinations.

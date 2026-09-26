# Audit and rehearse shipping gates

Use the configuration audit before activation and after policy changes. Use the
synthetic rehearsal to test GitHub orchestration separately from the private
producer/collector/reader contract. Neither result alone authorizes a release or
an installed upgrade.

## Read-only configuration audit

Run from a reviewed checkout with Node 20+ and an authenticated GitHub CLI:

```sh
node .github/scripts/shipping-audit.cjs live OWNER/REPOSITORY > /tmp/shipping-audit.json
```

Exit 0 means the inspected configuration matches the supported policy; exit 1
means hold; exit 2 means input/collection failed. Output has an action for every
hold and bounded API error reasons, without secret values or raw API errors.
The CLI only makes GET requests. It does not configure or repair anything.

The inspector paginates rulesets (including inherited ones), branch policies and
secret-name inventories. It reads ruleset details to inspect bypass actors and
checks main's queue, status contexts and App bindings, PR review, force-push and
deletion rules, version-tag creation/update/deletion, environment review and
branch restrictions, credential location and default workflow permissions.
Unknown scope patterns, missing fields and incomplete reads hold. Rule names are
not evidence of enforcement. Only active rules with recognized scope count.

Use an identity with enough visibility to inspect bypass actors and environment
metadata. Secret listing reads names only; administration visibility is needed
to distinguish a missing classic branch rule from a hidden one. A snapshot can
also be evaluated with `snapshot /path/to/snapshot.json`, but a supplied snapshot
is test/diagnostic input, not fresh GitHub evidence.

`configured` is deliberately narrower than deployment approval. The audit does
not validate credential contents, publisher installation permissions, inherited
organization secrets, reviewer membership, workflow source, private dependency
access or deployed runtime revisions. Reads are not an atomic configuration
snapshot. Additional or classic restrictions can still block shipping. Record
those checks during the [activation procedure](SHIPPING.md).

## Create the disposable bundle

Choose an unused repository name ending in `-shipping-rehearsal`. Generate its
contents into a new directory; the command refuses existing directories:

```sh
node .github/scripts/shipping-rehearsal.cjs prepare \
  OWNER/EXPERIMENT-shipping-rehearsal /tmp/shipping-rehearsal-bundle
```

This performs no GitHub writes and does not initialize, create or push a repository.
Review the bundle before creating a separate disposable GitHub repository with
these contents and `main` as its default branch. Do not overwrite an existing
repository, mirror production credentials, or register this bundle as a plugin
marketplace. The generator rejects production repository names. Every generated
caller is additionally guarded by its exact repository marker.

The generated shipping/release callers copy the current reviewed source with a
sandbox guard. Compatibility is replaced by a small explicit synthetic fixture;
the four ordinary required CI contexts are synthetic placeholders. Release adds
a sandbox-only scenario dispatch input. Production workflows do not accept it.
The sandbox publisher will create real tags and GitHub Releases in the disposable
repository when the good case is exercised.

Configure the same main/check/tag rules and independently reviewed environments
from [SHIPPING.md](SHIPPING.md). Use a separate publisher App installed only on
the sandbox. The fixture does not read private repositories or use a read token;
if exercising the audit's secret-location check, use an inert placeholder named
`COMPATIBILITY_READ_TOKEN`, never a production credential. Such a configured
synthetic audit cannot prove actual private access. Retain the existing required
review controls and assign actual reviewers before enabling the queue.

## Run and observe cases

Use the same reviewed local checkout for generation, baseline and observation.
The baseline compares hosted workflow/script bytes to this generator's expected
bundle. It rejects arbitrary, older or modified templates. Observation compares
both baseline and run source hashes. Updating the tooling requires regenerating
and reviewing the bundle; do not edit receipts to accept different source.

Before enqueueing a PR or dispatching a release, record the baseline:

```sh
node .github/scripts/shipping-rehearsal.cjs baseline \
  OWNER/EXPERIMENT-shipping-rehearsal > /tmp/rehearsal-baseline.json
```

The baseline records main, source hashes and whether the manifest's version tag
and release are absent. It expires after 24 hours and must precede the run.
Allow the next whole second before starting a run because GitHub run timestamps
have second precision. Do not reuse a run from before the baseline or rerun an
old attempt; start a new case with a fresh baseline instead.

For queue cases, change only `compatibility/rehearsal-case.json` on a PR branch:

```json
{"scenario":"missing-evidence"}
```

Complete review and enqueue that PR. Record the `Shipping compatibility`
**merge_group** run ID, not the earlier PR admission run. Approve the synthetic
compatibility environment only after reviewing the scenario. The good case must
reach main with exactly the tested SHA. Bad cases must fail the actual required
policy step and leave main unchanged. Keep other sandbox activity stopped so
state changes can be attributed to this case.

For release cases, leave the queue fixture on `good`. Use a fresh version in the
plugin manifest for each case, reviewed through the queue, then take the baseline
and dispatch from main:

```sh
gh workflow run release.yml --repo OWNER/EXPERIMENT-shipping-rehearsal \
  --ref main -f scenario=changed-candidate
```

This dispatch writes only to the explicitly selected sandbox. Complete its
independent environment reviews as the run requests them. Fault selection is a
release input, so negative release cases do not require bypassing the queue to
merge a bad fixture. Record the resulting Release run ID.

| Scenario | Expected fixture / caller behavior |
| --- | --- |
| `good` | Exact fresh result; queue merges or publisher creates the synthetic release |
| `failure` | Fixture exits with the deliberate failure; shipping holds |
| `missing-evidence` | Fixture succeeds without a SHA; policy rejects |
| `changed-candidate` | Fixture reports another SHA; policy rejects |
| `stale-evidence` | Release only: old acceptance time; publication rejects |
| `cancelled` | After the fixture emission step starts, cancel the run in GitHub within one minute |
| `timeout` | Allow the emitting fixture to exceed its one-minute job deadline |

Cancellation before the emitting step starts does not exercise this case and is
held by the observer. Run cancellation and timeout remain distinct conclusions.
No tool automatically cancels runs, approves reviews, removes checks or deletes
rehearsal resources.

After the run finishes (and the good queue commit lands), collect the observation:

```sh
node .github/scripts/shipping-rehearsal.cjs observe \
  /tmp/rehearsal-baseline.json RUN_ID changed-candidate > /tmp/rehearsal-result.json
```

The observer uses GET only. It binds the repository, event, workflow, attempt,
run SHA, source hashes and scenario; reads all jobs; checks the actual emitting
and decision steps; and checks main/tag/release state. Missing evidence, unrelated
setup failures, changed source, pre-existing release tags, or a publisher token
step running after a policy failure cannot count as a successful negative test.
Pass means `synthetic-hosted-orchestration-only`, not full enforcement acceptance.
An early observation returns hold; inspect again after the same attempt completes.

## Complete hosted acceptance

Keep baseline/observation JSON, run URLs and effective configuration evidence
outside the public source tree. In addition to this tooling, verify:

- The queue actually removes bad candidates and denies direct main updates.
- Unauthorized tag creation and publisher tag update/deletion are denied.
- Main advancing during publisher review prevents release; an expired acceptance
  result also holds. The `changed-candidate` fixture tests wrong-SHA output, not
  a live concurrent update to main.
- A good release archive contains the intended commit's bytes. The observer
  checks uploaded asset metadata and the tag SHA, not archive bytes.
- The real private compatibility workflow passes good and rejects incompatible
  source compositions under the protected read credential.

These require live configuration, a scoped sandbox publisher and independent
reviewers. Generated files, local regression tests and a passing observation are
not substitutes. Production activation remains a separate reviewed action.

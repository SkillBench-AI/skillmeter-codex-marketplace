# Released-state upgrade checks

Run `node --test plugins/skillmeter/test/released-upgrades.test.js` from a checkout
with full Git history. The test extracts immutable release commits listed in
`compatibility/contract.json` at the repository root; it neither downloads releases nor uses the
installed plugin. A missing commit or manifest-version mismatch fails the test.

Coverage currently includes direct upgrades from 0.6.0, 0.6.1, 0.7.0 and 0.8.0
to the candidate queue implementation. The released code creates actual queue
state, with both acknowledged and pending-chunk cases. The candidate must retain
pending bytes through retry, preserve source/cursor identity, capture unstaged
work and authored repeats, reopen a queue copy, and rebuild an authorized baseline
after a reset request. Legacy cursors additionally exercise explicit migration
and recovery from an interrupted migration receipt.

All source, approval ranges and state are synthetic. A fully authorized fixture
does not authorize real historical ranges. The test loads queue/sanitizer modules
only, not released hooks or installers. It does not establish auth/shared-policy
compatibility, actual install/restart behavior, concurrent old/new writer safety,
collector deployment, retention or analysis behavior. The copied queue is a local
reopen check, not a production rollback certificate.

`cursor-format.test.js` verifies that unknown cursor or metadata formats hold
before consent observation, staging, recovery or draining changes durable queue
data. Published transaction cursors are checked even if cursor.json is absent.
This protects this candidate from future formats; it cannot retrofit released
clients. Stop old writers before any format-changing migration.

These tests run in the normal Node 20/22 CI jobs. They cover the listed formats,
not an unlimited support promise. New state formats must add a released-state
fixture, interrupted migration tests and a defined recovery path. Backend
compatibility still requires the separately pinned collector/reader contract.
Refer to the canonical Claude ADR 005 for the proposed shared compatibility
contract. No version-retirement window is declared by this fixture list.

## Persistent installation state

Runtime queues use host-provided `PLUGIN_DATA` (or `CLAUDE_PLUGIN_DATA`). Without
either variable, the runtime derives `plugins/data/<plugin>-<marketplace>` only
from a recognized `plugins/cache/<marketplace>/<plugin>/<version>` layout with
an existing data parent. It propagates the resolved absolute path to detached
workers. It never falls back to writing inside the versioned installation.

If a sibling cached version contains log state, inferred routing stops with
`legacy-install-data-recovery-required`. Reconcile that state explicitly before
selecting a data directory; merely pointing at an empty one can strand it. A
source checkout or unrecognized layout requires an explicit `PLUGIN_DATA` path
and otherwise stops with `persistent-plugin-data-unavailable`. An explicit path
is an operator/host routing choice, not authorization to collect or replay data.

`persistent-data-root.test.js` exercises the real logger in child processes,
directory replacement, inherited data selection and the legacy-state hold using
temporary fixtures. It does not exercise the desktop's actual install/update UI.

## Authentication and shared clients

`released-auth-upgrades.test.js` loads each released credential writer in an
isolated child process and exercises candidate delivery. The matrix covers sign-in,
sign-out, expired credentials, global pause, withdrawn organization scope,
repository revocation, interrupted refresh and authentication rejection. Held
batches retain their bytes and retry budget; device identity, salt and unknown
credential fields survive. All network calls are intercepted, shell/daemon calls
are denied, and the fixture redirects the home resolver before loading modules.

Run `node plugins/skillmeter/integration/check_mixed_auth.cjs /path/to/claude`
for the separate mixed-client acceptance gate. A queue-compatible candidate can
still fail shared-policy semantics. See [release acceptance](RELEASE-ACCEPTANCE.md)
for CI setup, exact-revision evidence, deployment order and rollback limits.

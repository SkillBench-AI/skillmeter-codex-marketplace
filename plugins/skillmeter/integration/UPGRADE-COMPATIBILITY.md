# Released-state upgrade checks

Run `node --test plugins/skillmeter/test/released-upgrades.test.js` from a checkout
with full Git history. The test extracts immutable release commits listed in
`test/compatibility/releases.json`; it neither downloads releases nor uses the
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

# Transcript transport and local verification

Run `npm run check` from the repo root for plugin-only checks. They cover chunk
headers, scope/consent, auth containment, response loss, concurrent drains and
SIGKILL recovery. No collector or pipeline deployment is required.

## Optional cross-repository contract

Run with the pipeline's locked Python 3.14 environment (`moto[s3]`, boto3 and
skillbench-preprocessor installed), Node >=20, and collector Go 1.25.5 dependencies.
No Docker or real credentials are needed. The runner binds loopback ports only.

### Pinned candidate gate

From a clean plugin checkout, pin clean collector and pipeline checkouts, then run:

```sh
python3 -B plugins/skillmeter/integration/candidate_contract.py pin \
  --collector /path/to/collector --pipeline /path/to/pipelines \
  --manifest /tmp/candidate.json
python3 -B plugins/skillmeter/integration/candidate_contract.py run \
  --collector /path/to/collector --pipeline /path/to/pipelines \
  --manifest /tmp/candidate.json --out /tmp/candidate-result.json \
  --python /path/to/pipelines/.venv/bin/python --go /path/to/go
```

The manifest pins all three commit SHAs plus lockfile/fixture hashes. The command
rejects dirty or changed checkouts, checks pipeline imports resolve to the selected
tree, builds the Go bridge from source, and rechecks the pins after execution.
Install dependencies separately using the repository lockfiles. Go uses existing
local caches with downloads disabled. Python dependency versions are fingerprinted
in the receipt; the runner does not certify that a reused environment matches its
lockfile. It does not certify arbitrary ignored files or an untrusted runtime.

Stage results cover transport/recovery, stored-record equality, normalization,
scripted analysis and ingest schema. A failed run retains completed stages and
labels later stages `not-run`. Missing evidence cannot pass, and a new run replaces
an older receipt before validation. Exit 0 means every synthetic stage passed;
1 means a gate failed; 2 means invalid invocation or an unavailable output path.
Keep manifests and results outside the candidate checkouts.

The run uses temporary fixture credentials/home, excludes inherited model/AWS
credentials and blocks non-loopback Python connections. Output contains hashes,
counts, revisions and reason codes. The fixture explicitly opts in before writing
source records. Expectations cover sanitizer policy 3.1.1, opaque tool inputs,
unknown text provenance and collector generation frames. Fixture objects are
re-keyed inside the emulator to exercise date-gap recovery, so this is not a
report-week membership test. Full runs require a compatible continuation reader.

CI runs the runner's stdlib boundary tests. The full cross-repository command is
ready for an integration job with approved checkout access; this PR does not add
cross-repository credentials, a required status check or a production schedule.

```sh
python3 -B -m unittest discover -s plugins/skillmeter/integration -p 'test_candidate_contract.py' -v
```

### Direct debugging

For lower-level debugging without pinned provenance, build and run directly:

From the collector checkout, build the helper using the current collector source:

```sh
go build -o /tmp/skillbench-collector-bridge /path/to/plugin/plugins/skillmeter/integration/collector_bridge.go
```

From the plugin checkout:

```sh
/path/to/pipelines/.venv/bin/python plugins/skillmeter/integration/run_contract.py \
  --bridge /tmp/skillbench-collector-bridge \
  --pipeline /path/to/pipelines --out /tmp/contract-evidence.json
```

The uploader sends gzip chunks through the collector handler and storage code
into a local S3 emulator. Checks cover lost-response retries, append ordering,
midnight and multi-day resumes, baseline resets, stale generations and stored
bytes. Expected records and redaction checks are independent of the uploader.

`--pipeline` uses the larger Codex fixture, scripted analyzer responses and the
report schema validator. Omit it for parser/transport checks. Multi-day recovery
requires collector missing-baseline support.

The adapter omits API Gateway JWT verification. It does not exercise real
credentials, installed hooks, live storage, model services or a dashboard.
Fixture state is temporary; `--out` contains test results without transcript text.

Measure capture cost without network or credentials:

```sh
node plugins/skillmeter/integration/measure_capture.cjs
```

This creates and removes a synthetic 64 MiB source. It reports bytes read and
warm-cache elapsed time for unchanged and appended captures. It is an observation,
not a platform-independent performance threshold; prefix verification remains
linear in source size.

## Queue and recovery

Capture hints live in `logs/transcripts/captures-v1/`. Immutable gzip chunks,
transaction manifests and raw-byte cursors live in `logs/transcripts/chunks-v1/`.
Transactions publish chunks before advancing the cursor; restart recovery finishes
published transactions. Rewrites start a higher reset generation. Transport UUIDs
use raw position/content to preserve distinct records that sanitize identically.

Chunks budget gzip/base64 bytes below 5 MiB including a 128 KiB envelope reserve;
decoded records must remain below 32 MiB. Malformed/oversized input retains the
source and cursor with a content-free diagnostic. Failed chunks and superseded
reset generations are retained; historical transcripts are not replayed automatically.

Queues created with an earlier owner-identity formula remain preserved but may
not be eligible for delivery. Never edit their owner fields to force migration;
select still-authorized source files for explicit recovery instead.

Read-only inventory (from the plugin directory):

```sh
PLUGIN_DATA=/path/to/plugin-data node scripts/transcript_inventory.js
```

Uploads send `X-Transcript-Protocol: chunks-v1`. The on-disk `chunks-v1/`
queue format is separate from this header. Missing-baseline recovery requires
the collector to return 409 for an append without a baseline; the client then
sends a full reset. Without that support, multi-day resumes may produce partial
snapshots.

Rollback: pause telemetry and retain the plugin data directory. The old client
cannot read `chunks-v1`; do not relabel chunks as legacy snapshots or run old
cleanup against them. Resume with a compatible client or select still-authorized
sources for explicit recovery. Verify installed-client behavior, storage and
report correctness separately from these local tests.

## Stored-record reconciliation

Use the [selected transcript integrity check](TRANSCRIPT-INTEGRITY.md) to compare
expected sanitized records with approved stored objects using content-free
receipts. This is a record-set gate; it does not establish full-source coverage
or weekly-report acceptance.

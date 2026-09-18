# Transcript transport and local verification

Run `npm run check` from the repo root for plugin-only checks. They cover chunk
headers, scope/consent, auth containment, response loss, concurrent drains and
SIGKILL recovery. No collector or pipeline deployment is required.

## Optional cross-repository contract

Run with the pipeline's locked Python 3.14 environment (`moto[s3]`, boto3 and
skillbench-preprocessor installed), Node >=20, and collector Go 1.25.5 dependencies.
No Docker or real credentials are needed. The runner binds loopback ports only.

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

The real uploader sends gzip chunks through the Go APIHandler, EventProcessor
and PromptStore, which use conditional writes through an HTTP S3 emulator. The
helper drops the first response after storage commits; the client retries the
same body, then appends. Only emulator objects are moved to synthetic older date
keys to exercise midnight and three-day resumes. The runner compares exact
stored bytes, repeats, full-reset recovery and stale-generation rejection, then
normalizes retained snapshots once per session.

`--pipeline` selects the substantive Codex fixture and runs the existing analyzer
with its default ten-block threshold, scripted LLM responses and the existing
ingest schema validator. Omit it for the smaller parser/transport-only fixture.
The Go helper must include the collector repair before testing multi-day recovery.

The adapter substitutes for API Gateway and omits JWT verification. No actual
backend ingest/read, model service, installed CLI/desktop hook, or dashboard is
exercised. All fixture state is temporary; only content-free evidence is written
to `--out`. No real credentials or user transcripts are used.

The stored transcript is also compared against fixture-authored expectations
independent of staged bytes, including redaction canaries. With `--pipeline`,
canonical messages and tool blocks must match the pre-implementation golden.

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
reset generations are retained; automatic historical replay is outside this change.

Queues created with an earlier owner-identity formula remain preserved but may
not be eligible for delivery. Never edit their owner fields to force migration;
select still-authorized source files for explicit recovery instead.

Read-only inventory (from the plugin directory):

```sh
PLUGIN_DATA=/path/to/plugin-data node scripts/transcript_inventory.js
```

The existing collector accepts chunk headers and ignores the optional
`X-Transcript-Protocol: chunks-v1`. This wire protocol name is separate from the
on-disk `logs/transcripts/chunks-v1/` format, which is unchanged in 0.5.1.
Collector #44 adds a 409 response when
an append has no baseline, allowing a scoped full reset. Without that extension,
resuming beyond the collector's today/yesterday window can yield a partial
snapshot; the plugin fix alone does not establish multi-day continuity.

Rollback: pause telemetry and retain the plugin data directory. The old client
cannot read `chunks-v1`; do not relabel chunks as legacy snapshots or run old
cleanup against them. Resume with a compatible client or select still-authorized
sources for explicit recovery. Live transcript storage, installed-client behavior
and report correctness are tracked separately in INF-231 / INF-210.

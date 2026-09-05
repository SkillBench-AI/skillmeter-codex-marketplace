# Local synthetic transport contract

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

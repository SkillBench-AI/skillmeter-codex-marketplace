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
  --bridge /tmp/skillbench-collector-bridge --out /tmp/contract-evidence.json
```

The real uploader sends gzip chunks to the Go EventProcessor and PromptStore,
which use conditional writes through an HTTP S3 emulator. The helper drops the
first response after storage commits; the client retries unchanged, then appends.
The runner checks exact stored bytes, repeated-record retention, and the shared
parser's structured export. The HTTP adapter substitutes for API Gateway and
omits JWT verification. This does not prove deployed routing/authentication,
midnight/multi-day continuity, analyzer output, backend ingest/read, or a dashboard.
All fixture state is temporary. Only content-free evidence is written to `--out`.

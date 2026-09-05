"""Local-only Node uploader -> Go handler -> S3 HTTP -> shared parser proof.

Run with the pipeline's locked Python environment. The Go helper must be built
from the collector checkout, so the tested handler/storage are actual source.
This is deterministic boundary evidence, not a live dashboard canary.
"""
import argparse
import base64
import urllib.request
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from datetime import datetime, UTC, timedelta

import boto3
from moto.server import ThreadedMotoServer
from skillbench_preprocessor import JobWindow, S3Source, preprocess, structured_session


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bridge", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--pipeline", type=Path, help="Pipeline checkout: use substantive fixture and scripted analyzer")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="codex-contract-") as temporary:
        root = Path(temporary)
        server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
        server.start()
        _, port = server.get_host_and_port()
        endpoint = f"http://127.0.0.1:{port}"
        env = {**os.environ, "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing",
               "AWS_SESSION_TOKEN": "testing", "AWS_REGION": "us-east-1", "AWS_DEFAULT_REGION": "us-east-1",
               "AWS_ENDPOINT_URL_S3": endpoint, "AWS_EC2_METADATA_DISABLED": "true",
               "AWS_CONFIG_FILE": str(root / "no-config"), "AWS_SHARED_CREDENTIALS_FILE": str(root / "no-creds"),
               "PROMPT_BUCKET_NAME": "synthetic-transcripts"}
        env.pop("AWS_PROFILE", None)
        client = boto3.client("s3", endpoint_url=endpoint, region_name="us-east-1",
                              aws_access_key_id="testing", aws_secret_access_key="testing")
        client.create_bucket(Bucket="synthetic-transcripts")
        with (root / "bridge.log").open("w") as log:
            bridge = subprocess.Popen([str(args.bridge)], env=env, stdout=subprocess.PIPE, stderr=log, text=True)
            try:
                endpoint_info = json.loads(bridge.stdout.readline())
                command = ["node", str(Path(__file__).with_name("upload_fixture.cjs")), str(root), endpoint_info["url"]]
                if args.pipeline:
                    command.append(str(args.pipeline / "packages/preprocessor/tests/fixtures/codex_m0/substantive.jsonl"))
                result = subprocess.run(command, capture_output=True, text=True, timeout=30)
                if result.returncode:
                    raise RuntimeError(result.stderr)
                listed = client.list_objects_v2(Bucket="synthetic-transcripts")["Contents"]
                assert len(listed) == 1
                key = listed[0]["Key"]
                stored = client.get_object(Bucket="synthetic-transcripts", Key=key)["Body"].read()
                expected = (root / "expected.jsonl").read_bytes()
                assert stored == expected, "S3 transcript differs from actual staged bytes"
                # Re-key only this emulator fixture to reproduce midnight and a
                # multi-day gap without changing machine time or live objects.
                resume_attempts = []
                today_date = datetime.now(UTC).date()
                for days in (1, 3):
                    older = "/".join(["transcripts", "SYNTHETIC-DEVICE", (today_date - timedelta(days=days)).isoformat(), "synthetic.jsonl"])
                    client.copy_object(Bucket="synthetic-transcripts", Key=older, CopySource={"Bucket":"synthetic-transcripts", "Key":key})
                    client.delete_object(Bucket="synthetic-transcripts", Key=key)
                    resumed = subprocess.run(["node", str(Path(__file__).with_name("upload_fixture.cjs")), str(root), endpoint_info["url"], "append"], capture_output=True, text=True, timeout=30)
                    assert resumed.returncode == 0, resumed.stderr
                    resume_attempts.append(json.loads(resumed.stdout)["attempts"])
                    key = older if days == 1 else f"transcripts/SYNTHETIC-DEVICE/{today_date}/synthetic.jsonl"
                    stored = client.get_object(Bucket="synthetic-transcripts", Key=key)["Body"].read()
                    expected = (root / "expected.jsonl").read_bytes()
                    assert stored == expected, f"resume after {days} days lost the prefix"
                assert resume_attempts[1][0]["status"] == 409
                assert resume_attempts[1][1]["seq"] == resume_attempts[1][1]["reset"]
                stale = json.loads((root / "stale-request.json").read_text())
                request = urllib.request.Request(endpoint_info["url"] + "/transcript", data=base64.b64decode(stale["body"]), headers=stale["headers"], method="POST")
                with urllib.request.urlopen(request, timeout=5) as response:
                    assert response.status < 300
                assert client.get_object(Bucket="synthetic-transcripts", Key=key)["Body"].read() == stored
                # Inject only the S3 client seam; Source listing/fetch, detection,
                # Codex normalization and structured projection are actual code.
                source = S3Source("synthetic-transcripts", client=client)
                today = datetime.now(UTC).date().isoformat()
                parsed = preprocess(source, JobWindow(("SYNTHETIC-DEVICE",), (today_date - timedelta(days=4)).isoformat(), today), project=structured_session)
                assert len(parsed.sessions) == 1 and parsed.sessions[0]["agent"] == "codex"
                assert not any(d.actionable for d in parsed.diagnostics)
                assert any(d.status == "superseded-snapshot" for d in parsed.diagnostics)
                messages = parsed.sessions[0]["messages"]
                repeats = sum(any(b.get("text") == "A real repeated synthetic request" for b in m["content"]) for m in messages)
                assert repeats == 2
                report_evidence = None
                if args.pipeline:
                    from ai_usage_analyser.job import JobOutputs, run_job
                    from ai_usage_analyser.ingest import build_ingest_request, version_key
                    from ai_usage_analyser.pipeline.analysis.config import PipelineConfig
                    from ai_usage_analyser.pipeline.analysis.classify.llm_tech_stack import reset_cache

                    spec = importlib.util.spec_from_file_location("fixture_helpers", args.pipeline / "apps/ai-usage-analyser/tests/helpers.py")
                    helpers = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(helpers)
                    reset_cache()
                    responses = helpers.report_llm_script(50)
                    with helpers.patched_llm(responses) as llm:
                        result = run_job(user_alt_id="synthetic-codex-user", device_ids=["SYNTHETIC-DEVICE"],
                                         start_date=(today_date - timedelta(days=4)).isoformat(), end_date=today,
                                         source=source, output_root=root / "reports", config=PipelineConfig(max_workers=1))
                    assert isinstance(result, JobOutputs), "default analyzer threshold must pass"
                    assert llm.call_count == len(responses) - 1, "only optional productivity call is absent"
                    assert llm.call_args_list[0].kwargs["schema"]["name"] == "tech_stack"
                    assert llm.call_args_list[1].kwargs["schema"]["name"] == "classification"
                    assert version_key(result.report) == result.version_key
                    request = build_ingest_request(report=result.report, meta=result.meta,
                                                   start_date=(today_date - timedelta(days=4)).isoformat(), end_date=today,
                                                   period="weekly", key=result.version_key)
                    assert request.versionKey == result.version_key
                    report_evidence = {"versionKey": result.version_key, "schemaValidated": True,
                                       "llm": "scripted synthetic responses", "minimumBlocks": 10}
                evidence = {"syntheticOnly": True, "boundaries": ["actual Node uploader", "Go APIHandler/EventProcessor", "Go PromptStore", "HTTP S3 emulator", "shared preprocessor"] + (["existing analyzer with scripted LLM", "report ingest schema"] if args.pipeline else []),
                            "sourceKey": key, "storedSha256": hashlib.sha256(stored).hexdigest(),
                            "records": len(stored.splitlines()), "canonicalSessions": 1, "canonicalMessages": len(messages),
                            "repeatedMessagesRetained": repeats, "requestAttempts": json.loads((root / "attempts.json").read_text()),
                            "resumeAttempts": resume_attempts, "staleGenerationIgnored": True, "snapshotsSelected": 1,
                            "analyzerReport": report_evidence, "backendDashboard": False}
                args.out.parent.mkdir(parents=True, exist_ok=True)
                args.out.write_text(json.dumps(evidence, indent=2) + "\n")
                print(json.dumps(evidence))
            finally:
                bridge.terminate()
                bridge.wait(timeout=5)
                server.stop()


if __name__ == "__main__":
    main()

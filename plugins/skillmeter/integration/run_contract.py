"""Local-only Node uploader -> Go handler -> S3 HTTP -> shared parser proof.

Run with the pipeline's locked Python environment. The Go helper must be built
from the collector checkout, so the tested handler/storage are actual source.
This is deterministic boundary evidence, not a live dashboard canary.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from datetime import datetime, UTC

import boto3
from moto.server import ThreadedMotoServer
from skillbench_preprocessor import JobWindow, S3Source, preprocess, structured_session


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bridge", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
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
                result = subprocess.run(["node", str(Path(__file__).with_name("upload_fixture.cjs")), str(root), endpoint_info["url"]], capture_output=True, text=True, timeout=30)
                if result.returncode:
                    raise RuntimeError(result.stderr)
                listed = client.list_objects_v2(Bucket="synthetic-transcripts")["Contents"]
                assert len(listed) == 1
                key = listed[0]["Key"]
                stored = client.get_object(Bucket="synthetic-transcripts", Key=key)["Body"].read()
                expected = (root / "expected.jsonl").read_bytes()
                assert stored == expected, "S3 transcript differs from actual staged bytes"
                # Inject only the S3 client seam; Source listing/fetch, detection,
                # Codex normalization and structured projection are actual code.
                source = S3Source("synthetic-transcripts", client=client)
                today = datetime.now(UTC).date().isoformat()
                parsed = preprocess(source, JobWindow(("SYNTHETIC-DEVICE",), today, today), project=structured_session)
                assert len(parsed.sessions) == 1 and parsed.sessions[0]["agent"] == "codex"
                assert not any(d.actionable for d in parsed.diagnostics)
                messages = parsed.sessions[0]["messages"]
                repeats = sum(any(b.get("text") == "A real repeated synthetic request" for b in m["content"]) for m in messages)
                assert repeats == 2
                evidence = {"syntheticOnly": True, "boundaries": ["actual Node uploader", "Go EventProcessor", "Go PromptStore", "HTTP S3 emulator", "shared preprocessor"],
                            "sourceKey": key, "storedSha256": hashlib.sha256(stored).hexdigest(),
                            "records": len(stored.splitlines()), "canonicalSessions": 1, "canonicalMessages": len(messages),
                            "repeatedMessagesRetained": repeats, "requestAttempts": json.loads((root / "attempts.json").read_text()),
                            "analyzerReport": False, "backendDashboard": False}
                args.out.parent.mkdir(parents=True, exist_ok=True)
                args.out.write_text(json.dumps(evidence, indent=2) + "\n")
                print(json.dumps(evidence))
            finally:
                bridge.terminate()
                bridge.wait(timeout=5)
                server.stop()


if __name__ == "__main__":
    main()

"""Local-only Node uploader -> Go handler -> S3 HTTP -> shared parser proof.

Run with the pipeline's locked Python environment. The Go helper must be built
from the collector checkout, so the tested handler/storage are actual source.
This is deterministic boundary evidence, not a live dashboard canary.
"""

import argparse
import sys

from contract_stages import StageResults


def loopback_only(event, args):
    if event in {"socket.connect", "socket.getaddrinfo"}:
        address = args[1] if event == "socket.connect" else args
        if not isinstance(address, tuple) or address[0] not in {"127.0.0.1", "::1", "localhost"}:
            raise RuntimeError("synthetic-run-network-boundary")


# A missing scripted mock must fail instead of reaching a real model service.
sys.addaudithook(loopback_only)
if sys.flags.optimize:
    raise RuntimeError("contract-assertions-required")
import base64
import urllib.request
import hashlib
import hmac
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


def transcript_body(stored, generation):
    header, body = stored.split(b"\n", 1)
    assert json.loads(header) == {
        "type": "skillbench_transcript_state",
        "version": 1,
        "reset_generation": generation,
        "baseline_complete": True,
    }
    return body


def assert_independent_transcript(stored, fixture, root):
    """Fixture-authored expectations, independent of staged bytes and sanitizer."""
    expected = [json.loads(line) for line in fixture.read_text().splitlines()]
    workspace = hmac.new(b"fixture-salt", str(root / "repo").encode(), hashlib.sha256).hexdigest()[
        :12
    ]
    for record in expected:
        if "cwd" in record.get("payload", {}):
            record["payload"]["cwd"] = workspace
    expected[0]["payload"].update(contact="[EMAIL]", api_key="[REDACTED_SECRET]")
    for role, text in [
        ("user", "A real repeated synthetic request"),
        ("user", "A real repeated synthetic request"),
        ("assistant", "Synthetic continuation after lost response"),
        ("user", "Synthetic multi-day continuation"),
        ("user", "Synthetic multi-day continuation"),
    ]:
        expected.append(
            {
                "type": "response_item",
                "timestamp": "2026-09-04T12:00:02Z",
                "payload": {
                    "type": "message",
                    "role": role,
                    "content": [
                        {
                            "type": "input_text" if role == "user" else "output_text",
                            "text": text,
                        }
                    ],
                },
            }
        )
    # Explicit expectations for these fixtures under the pinned sanitizer policy.
    for index, record in enumerate(expected):
        payload = record.get("payload", {})
        paths = int("cwd" in payload)
        if payload.get("type") == "function_call":
            args = json.loads(payload["arguments"])
            args["cmd"] = hmac.new(
                b"fixture-salt", args["cmd"].encode(), hashlib.sha256
            ).hexdigest()[:12]
            payload["arguments"] = json.dumps(args, separators=(",", ":"))
            paths += 1
        if payload.get("type") == "custom_tool_call":
            payload["input"] = hmac.new(
                b"fixture-salt", payload["input"].encode(), hashlib.sha256
            ).hexdigest()[:12]
            paths += 1
        counts = dict(secret=0, email=0, person=0, phone=0, ip=0, id_number=0, card=0, path=paths)
        if index == 0:
            counts.update(secret=1, email=1)
        record["_sanitization"] = {
            "policyVersion": "3.1.1",
            "secrets": int(index == 0),
            "pii": int(index == 0),
            "counts": counts,
            "ids": ["email", "labelled-secret"] if index == 0 else [],
        }
    actual = [json.loads(line) for line in stored.splitlines()]
    identities = [record.pop("uuid") for record in actual]
    assert len(set(identities)) == len(expected)
    assert all(
        len(identity) == 64 and all(c in "0123456789abcdef" for c in identity)
        for identity in identities
    )
    assert actual == expected, "stored records differ from the independently specified fixture"
    # Final recovery is generation 2. Compute IDs from raw source positions,
    # independently of the Node queue and observed transport records.
    salt = b"fixture-salt"
    digest = lambda value: hmac.new(salt, value, hashlib.sha256).hexdigest()
    source_id = digest(str(root / "synthetic.jsonl").encode())
    offset = 0
    raw_lines = (root / "synthetic.jsonl").read_bytes().splitlines(keepends=True)
    assert len(raw_lines) == len(expected)
    for record, raw in zip(expected, raw_lines, strict=True):
        record["uuid"] = digest(f"{source_id}\0{2}\0{offset}\0{digest(raw)}".encode())
        offset += len(raw)
    expected_file = root / "independent-expected.jsonl"
    expected_file.write_text("".join(json.dumps(record) + "\n" for record in expected))
    stored_file = root / "independent-observed.jsonl"
    stored_file.write_bytes(stored)
    checker = Path(__file__).with_name("transcript_integrity.cjs")
    receipts = []
    for name, source in [("expected", expected_file), ("observed", stored_file)]:
        result = subprocess.run(
            ["node", str(checker), "receipt", str(source)],
            capture_output=True,
            check=True,
            timeout=30,
        )
        target = root / f"{name}-receipt.json"
        target.write_bytes(result.stdout)
        receipts.append(target)
    comparison = subprocess.run(
        ["node", str(checker), "compare", *map(str, receipts)],
        capture_output=True,
        check=True,
        timeout=30,
    )
    return workspace, json.loads(comparison.stdout)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bridge", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--stages", type=Path)
    parser.add_argument(
        "--pipeline",
        type=Path,
        help="Pipeline checkout: use substantive fixture and scripted analyzer",
    )
    args = parser.parse_args()
    stages = StageResults(args.stages)
    stages.start("transport-recovery")
    with tempfile.TemporaryDirectory(prefix="codex-contract-") as temporary:
        root = Path(temporary)
        server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
        server.start()
        _, port = server.get_host_and_port()
        endpoint = f"http://127.0.0.1:{port}"
        env = {
            **os.environ,
            "AWS_ACCESS_KEY_ID": "testing",
            "AWS_SECRET_ACCESS_KEY": "testing",
            "AWS_SESSION_TOKEN": "testing",
            "AWS_REGION": "us-east-1",
            "AWS_DEFAULT_REGION": "us-east-1",
            "AWS_ENDPOINT_URL_S3": endpoint,
            "AWS_EC2_METADATA_DISABLED": "true",
            "AWS_CONFIG_FILE": str(root / "no-config"),
            "AWS_SHARED_CREDENTIALS_FILE": str(root / "no-creds"),
            "PROMPT_BUCKET_NAME": "synthetic-transcripts",
        }
        env.pop("AWS_PROFILE", None)
        client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name="us-east-1",
            aws_access_key_id="testing",
            aws_secret_access_key="testing",
        )
        client.create_bucket(Bucket="synthetic-transcripts")
        with (root / "bridge.log").open("w") as log:
            bridge = subprocess.Popen(
                [str(args.bridge)],
                env=env,
                stdout=subprocess.PIPE,
                stderr=log,
                text=True,
            )
            try:
                endpoint_info = json.loads(bridge.stdout.readline())
                command = [
                    "node",
                    str(Path(__file__).with_name("upload_fixture.cjs")),
                    str(root),
                    endpoint_info["url"],
                ]
                if args.pipeline:
                    command.append(
                        str(
                            args.pipeline
                            / "packages/preprocessor/tests/fixtures/codex_m0/substantive.jsonl"
                        )
                    )
                result = subprocess.run(command, capture_output=True, text=True, timeout=30)
                if result.returncode:
                    raise RuntimeError(result.stderr)
                listed = client.list_objects_v2(Bucket="synthetic-transcripts")["Contents"]
                assert len(listed) == 1
                key = listed[0]["Key"]
                stored = client.get_object(Bucket="synthetic-transcripts", Key=key)["Body"].read()
                expected = (root / "expected.jsonl").read_bytes()
                assert transcript_body(stored, 1) == expected, (
                    "S3 transcript differs from actual staged bytes"
                )
                # Re-key only this emulator fixture to reproduce midnight and a
                # multi-day gap without changing machine time or live objects.
                resume_attempts = []
                today_date = datetime.now(UTC).date()
                for days in (1, 3):
                    older = "/".join(
                        [
                            "transcripts",
                            "SYNTHETIC-DEVICE",
                            (today_date - timedelta(days=days)).isoformat(),
                            "synthetic.jsonl",
                        ]
                    )
                    client.copy_object(
                        Bucket="synthetic-transcripts",
                        Key=older,
                        CopySource={"Bucket": "synthetic-transcripts", "Key": key},
                    )
                    client.delete_object(Bucket="synthetic-transcripts", Key=key)
                    resumed = subprocess.run(
                        [
                            "node",
                            str(Path(__file__).with_name("upload_fixture.cjs")),
                            str(root),
                            endpoint_info["url"],
                            "append",
                        ],
                        capture_output=True,
                        text=True,
                        timeout=30,
                    )
                    assert resumed.returncode == 0, resumed.stderr
                    resume_attempts.append(json.loads(resumed.stdout)["attempts"])
                    if days == 1:
                        key = older
                    else:
                        created = [
                            item["Key"]
                            for item in client.list_objects_v2(Bucket="synthetic-transcripts")[
                                "Contents"
                            ]
                            if item["Key"] != older
                        ]
                        assert len(created) == 1
                        key = created[0]
                        # The fixture has fixed historical event times. Re-key its
                        # new baseline into the synthetic selection window only.
                        selected = f"transcripts/SYNTHETIC-DEVICE/{today_date}/synthetic.jsonl"
                        if key != selected:
                            client.copy_object(
                                Bucket="synthetic-transcripts",
                                Key=selected,
                                CopySource={"Bucket": "synthetic-transcripts", "Key": key},
                            )
                            client.delete_object(Bucket="synthetic-transcripts", Key=key)
                            key = selected
                    stored = client.get_object(Bucket="synthetic-transcripts", Key=key)[
                        "Body"
                    ].read()
                    expected = (root / "expected.jsonl").read_bytes()
                    assert (
                        transcript_body(stored, int(resume_attempts[-1][-1]["reset"])) == expected
                    ), f"resume after {days} days lost the prefix"
                assert resume_attempts[1][0]["status"] == 409
                assert resume_attempts[1][1]["seq"] == resume_attempts[1][1]["reset"]
                stale = json.loads((root / "stale-request.json").read_text())
                request = urllib.request.Request(
                    endpoint_info["url"] + "/transcript",
                    data=base64.b64decode(stale["body"]),
                    headers=stale["headers"],
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=5) as response:
                    assert response.status < 300
                assert (
                    client.get_object(Bucket="synthetic-transcripts", Key=key)["Body"].read()
                    == stored
                )
                fixture = (
                    args.pipeline
                    / "packages/preprocessor/tests/fixtures/codex_m0/substantive.jsonl"
                    if args.pipeline
                    else Path(__file__).parent.parent / "test/fixtures/codex-m0.jsonl"
                )
                stages.passed()
                stages.start("stored-records")
                workspace, integrity = assert_independent_transcript(
                    transcript_body(stored, int(resume_attempts[-1][-1]["reset"])), fixture, root
                )
                stages.passed()
                stages.start("normalization")
                # Inject only the S3 client seam; Source listing/fetch, detection,
                # Codex normalization and structured projection are actual code.
                source = S3Source("synthetic-transcripts", client=client)
                today = datetime.now(UTC).date().isoformat()
                parsed = preprocess(
                    source,
                    JobWindow(
                        ("SYNTHETIC-DEVICE",),
                        (today_date - timedelta(days=4)).isoformat(),
                        today,
                    ),
                    project=structured_session,
                )
                assert len(parsed.sessions) == 1 and parsed.sessions[0]["agent"] == "codex"
                assert not any(d.actionable for d in parsed.diagnostics), [
                    d.status for d in parsed.diagnostics if d.actionable
                ]
                assert any(d.status == "superseded-snapshot" for d in parsed.diagnostics)
                messages = parsed.sessions[0]["messages"]
                repeats = sum(
                    any(b.get("text") == "A real repeated synthetic request" for b in m["content"])
                    for m in messages
                )
                assert repeats == 2
                if args.pipeline:
                    # This golden was authored before the parser implementation.
                    # Pin every source message/tool block and timestamp, not just counts.
                    from skillbench_preprocessor.parse import parse_transcript
                    from dataclasses import asdict

                    golden = json.loads(fixture.with_name("expected.json").read_text())
                    # Textual harness markers without source metadata retain
                    # unknown provenance; the raw historical golden predates it.
                    golden["messages"].insert(
                        0,
                        {
                            "role": "user",
                            "timestamp_ms": 1788566382000,
                            "content": [
                                {
                                    "type": "text",
                                    "text": "<environment_context>synthetic harness, not user work</environment_context>",
                                }
                            ],
                        },
                    )
                    for message in golden["messages"]:
                        if message["role"] == "user":
                            for block in message["content"]:
                                if block.get("type") == "text":
                                    block["provenance"] = {"origin": "unknown", "status": "missing"}
                    # The parser golden is raw; only known opaque command/patch
                    # inputs change after sanitization, not call IDs or results.
                    for message in golden["messages"]:
                        for block in message["content"]:
                            if block.get("type") != "tool_use":
                                continue
                            field = "patch" if block["name"] == "apply_patch" else "cmd"
                            value = block["input"][field]
                            block["input"] = {
                                field: hmac.new(
                                    b"fixture-salt", value.encode(), hashlib.sha256
                                ).hexdigest()[:12]
                            }
                    canonical = parse_transcript(stored, key)
                    assert canonical.workspace == workspace
                    assert canonical.session_id == golden["session_id"]
                    assert [
                        asdict(message) for message in canonical.messages[: len(golden["messages"])]
                    ] == golden["messages"]
                    assert len(canonical.messages) == len(golden["messages"]) + 5
                stages.passed()
                report_evidence = None
                if args.pipeline:
                    stages.start("scripted-analysis")
                    from ai_usage_analyser.job import JobOutputs, run_job
                    from ai_usage_analyser.ingest import (
                        build_ingest_request,
                        version_key,
                    )
                    from ai_usage_analyser.pipeline.analysis.config import (
                        PipelineConfig,
                    )
                    from ai_usage_analyser.pipeline.analysis.classify.llm_tech_stack import (
                        reset_cache,
                    )

                    spec = importlib.util.spec_from_file_location(
                        "fixture_helpers",
                        args.pipeline / "apps/ai-usage-analyser/tests/helpers.py",
                    )
                    helpers = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(helpers)
                    reset_cache()
                    # Opaque command/patch inputs expose no tech-stack candidates;
                    # no productivity source is configured for this synthetic run.
                    responses = helpers.report_llm_script(50)[1:-1]
                    with helpers.patched_llm(responses) as llm:
                        result = run_job(
                            user_alt_id="synthetic-codex-user",
                            device_ids=["SYNTHETIC-DEVICE"],
                            start_date=(today_date - timedelta(days=4)).isoformat(),
                            end_date=today,
                            source=source,
                            output_root=root / "reports",
                            config=PipelineConfig(max_workers=1),
                        )
                    assert isinstance(result, JobOutputs), "default analyzer threshold must pass"
                    assert llm.call_count == len(responses), "unexpected scripted-model call count"
                    assert llm.call_args_list[0].kwargs["schema"]["name"] == "classification"
                    assert llm.call_args_list[1].kwargs["schema"]["name"] == "skill_assessment"
                    assert version_key(result.report) == result.version_key
                    stages.passed()
                    stages.start("ingest-schema")
                    request = build_ingest_request(
                        report=result.report,
                        meta=result.meta,
                        start_date=(today_date - timedelta(days=4)).isoformat(),
                        end_date=today,
                        period="weekly",
                        key=result.version_key,
                    )
                    assert request.versionKey == result.version_key
                    report_evidence = {
                        "versionKey": result.version_key,
                        "schemaValidated": True,
                        "llm": "scripted synthetic responses",
                        "minimumBlocks": 10,
                    }
                    stages.passed()
                evidence = {
                    "recordIntegrity": integrity,
                    "syntheticOnly": True,
                    "boundaries": [
                        "actual Node uploader",
                        "Go APIHandler/EventProcessor",
                        "Go PromptStore",
                        "HTTP S3 emulator",
                        "shared preprocessor",
                    ]
                    + (
                        ["existing analyzer with scripted LLM", "report ingest schema"]
                        if args.pipeline
                        else []
                    ),
                    "sourceKey": key,
                    "storedSha256": hashlib.sha256(stored).hexdigest(),
                    "records": len(stored.splitlines()) - 1,
                    "storageFrameValidated": True,
                    "fixtureDateRekeyed": True,
                    "canonicalSessions": 1,
                    "canonicalMessages": len(messages),
                    "repeatedMessagesRetained": repeats,
                    "requestAttempts": json.loads((root / "attempts.json").read_text()),
                    "resumeAttempts": resume_attempts,
                    "staleGenerationIgnored": True,
                    "snapshotsSelected": 1,
                    "independentRecordOracle": True,
                    "independentCanonicalOracle": bool(args.pipeline),
                    "analyzerReport": report_evidence,
                    "backendDashboard": False,
                }
                args.out.parent.mkdir(parents=True, exist_ok=True)
                args.out.write_text(json.dumps(evidence, indent=2) + "\n")
                print(json.dumps(evidence))
            except BaseException as error:
                stages.failed(type(error).__name__)
                raise
            finally:
                bridge.terminate()
                bridge.wait(timeout=5)
                server.stop()


if __name__ == "__main__":
    main()

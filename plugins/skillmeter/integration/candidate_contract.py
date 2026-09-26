"""Pin and check a local synthetic producer/collector/pipeline composition."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

from contract_stages import STAGES, complete, write_json

PRODUCER = Path(__file__).resolve().parents[3]
INPUTS = {
    "producer": ["plugins/skillmeter/.codex-plugin/plugin.json"],
    "collector": ["go.mod", "go.sum"],
    "pipeline": [
        "uv.lock",
        "packages/preprocessor/tests/fixtures/codex_m0/substantive.jsonl",
        "packages/preprocessor/tests/fixtures/codex_m0/expected.json",
    ],
}


class GateError(Exception):
    """Reason codes only; never copy subprocess output into evidence."""


def execute(command, *, cwd=None, env=None, timeout=30):
    with subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    ) as process:
        try:
            stdout, _ = process.communicate(timeout=timeout)
        except BaseException:
            # The Python runner owns Go/Node children; killing only its PID leaks them.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate()
            raise
        if process.returncode:
            raise GateError("command-failed")
        return stdout.decode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def snapshot(name, root):
    root = root.resolve()
    git = lambda *args: execute(["git", "-C", str(root), *args]).strip()
    if Path(git("rev-parse", "--show-toplevel")).resolve() != root:
        raise GateError("checkout-root-required")
    if git("status", "--porcelain", "--untracked-files=all"):
        raise GateError("dirty-checkout")
    revision = git("rev-parse", "HEAD")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise GateError("invalid-revision")
    return {
        "revision": revision,
        "inputs": {file: digest((root / file).read_bytes()) for file in INPUTS[name]},
    }


def pin(roots):
    return {
        "version": 1,
        "kind": "synthetic-contract-candidate",
        "components": {name: snapshot(name, root) for name, root in roots.items()},
    }


def verify(manifest, roots):
    if manifest != pin(roots):
        raise GateError("candidate-mismatch")


def valid_manifest(manifest):
    if not isinstance(manifest, dict) or set(manifest) != {"version", "kind", "components"}:
        return False
    if (
        type(manifest["version"]) is not int
        or manifest["version"] != 1
        or manifest["kind"] != "synthetic-contract-candidate"
    ):
        return False
    if not isinstance(manifest["components"], dict) or set(manifest["components"]) != set(INPUTS):
        return False
    for name, component in manifest["components"].items():
        if not isinstance(component, dict) or set(component) != {"revision", "inputs"}:
            return False
        if not isinstance(component["revision"], str) or not re.fullmatch(
            r"[a-f0-9]{40}", component["revision"]
        ):
            return False
        if not isinstance(component["inputs"], dict) or set(component["inputs"]) != set(
            INPUTS[name]
        ):
            return False
        if not all(
            isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value)
            for value in component["inputs"].values()
        ):
            return False
    return True


def outside_checkouts(path, roots):
    if any(path.resolve().is_relative_to(root.resolve()) for root in roots.values()):
        raise GateError("evidence-must-be-outside-checkouts")


def runtime_environment(pipeline, home):
    # Do not forward real AWS/model credentials, proxy settings, NODE_OPTIONS,
    # PYTHONOPTIMIZE or the invoking client's telemetry configuration.
    env = {key: os.environ[key] for key in ("PATH", "TMPDIR", "SYSTEMROOT") if key in os.environ}
    sources = [
        p for group in ("packages", "apps") for p in sorted((pipeline / group).glob("*/src"))
    ]
    env.update(
        HOME=str(home),
        USERPROFILE=str(home),
        PYTHONPATH=os.pathsep.join(map(str, sources)),
        PYTHONDONTWRITEBYTECODE="1",
        PYTHONNOUSERSITE="1",
        AWS_EC2_METADATA_DISABLED="true",
    )
    return env


def pipeline_runtime(python, pipeline, env, cwd):
    modules = {
        "skillbench_preprocessor": "packages/preprocessor/src",
        "ai_usage_analyser": "apps/ai-usage-analyser/src",
        "skillbench_contracts": "packages/contracts/src",
        "skillbench_llm_gateway": "packages/llm-gateway/src",
        "skillbench_shared": "packages/shared/src",
    }
    script = """
import importlib.util, importlib.metadata, json, sys
names = json.loads(sys.argv[1])
print(json.dumps({"python": sys.version.split()[0], "origins": {
    name: importlib.util.find_spec(name).origin for name in names
}, "dependencies": sorted((d.metadata['Name'], d.version) for d in importlib.metadata.distributions())}))
"""
    result = json.loads(
        execute([str(python), "-B", "-c", script, json.dumps(list(modules))], env=env, cwd=cwd)
    )
    if tuple(map(int, result["python"].split(".")[:2])) < (3, 14):
        raise GateError("python-3.14-required")
    for module, directory in modules.items():
        if (
            not Path(result["origins"][module])
            .resolve()
            .is_relative_to((pipeline / directory).resolve())
        ):
            raise GateError("pipeline-import-mismatch")
    return {
        "python": result["python"],
        "dependencyInventorySha256": digest(canonical(result["dependencies"])),
    }


def valid_evidence(result):
    if not isinstance(result, dict):
        return False
    integrity = result.get("recordIntegrity")
    report = result.get("analyzerReport")
    return (
        isinstance(integrity, dict)
        and isinstance(report, dict)
        and result.get("syntheticOnly") is True
        and result.get("backendDashboard") is False
        and result.get("independentRecordOracle") is True
        and result.get("independentCanonicalOracle") is True
        and result.get("storageFrameValidated") is True
        and result.get("legacyMigrationVerified") is True
        and report.get("schemaValidated") is True
        and integrity.get("status") == "pass"
        and integrity.get("issues") == []
        and type(result.get("records")) is int
        and result["records"] > 0
        and type(integrity.get("expectedRecords")) is int
        and type(integrity.get("observedRecords")) is int
        and result["records"] == integrity["expectedRecords"] == integrity["observedRecords"]
    )


def run(manifest, roots, python, go, out):
    outside_checkouts(out, roots)
    receipt = {
        "version": 1,
        "kind": "synthetic-contract-run",
        "status": "running",
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "candidateSha256": digest(canonical(manifest)),
        "candidate": manifest if valid_manifest(manifest) else None,
        "stages": {
            name: {"status": "not-run"}
            for name in ("candidate", "build", *STAGES, "evidence", "candidate-recheck")
        },
        "limits": [
            "Synthetic local composition only; API Gateway authentication is omitted.",
            "Scripted model responses; no semantic-validity or live-model acceptance.",
            "No installed hooks, backend delivery, dashboard or weekly schedule acceptance.",
            "Revisions and locks are pinned; installed dependency versions are fingerprinted, not certified against lockfiles.",
        ],
    }
    active = "candidate"
    journal = None
    write_json(out, receipt)  # Replace earlier success before doing any work.
    try:
        if not valid_manifest(manifest):
            raise GateError("invalid-manifest")
        verify(manifest, roots)
        with tempfile.TemporaryDirectory(prefix="candidate-contract-") as temporary:
            temp = Path(temporary)
            env = runtime_environment(roots["pipeline"], temp)
            receipt["runtimes"] = pipeline_runtime(python, roots["pipeline"], env, temp)
            receipt["runtimes"]["node"] = execute(["node", "--version"], env=env).strip()
            if int(receipt["runtimes"]["node"].lstrip("v").split(".")[0]) < 20:
                raise GateError("node-20-required")
            receipt["runtimes"]["go"] = execute([go, "version"]).strip()
            receipt["stages"][active] = {"status": "pass"}
            active = "build"
            receipt["stages"][active] = {"status": "running"}
            write_json(out, receipt)
            # Reuse only local Go dependency/build caches. Never fetch or install.
            cache = json.loads(execute([go, "env", "-json", "GOPATH", "GOCACHE", "GOROOT"]))
            build_env = {**env, **cache, "GOPROXY": "off", "GOSUMDB": "off", "GOTOOLCHAIN": "local"}
            bridge = temp / "collector-bridge"
            execute(
                [
                    go,
                    "build",
                    "-mod=readonly",
                    "-o",
                    str(bridge),
                    str(PRODUCER / "plugins/skillmeter/integration/collector_bridge.go"),
                ],
                cwd=roots["collector"],
                env=build_env,
                timeout=180,
            )
            receipt["bridgeSha256"] = digest(bridge.read_bytes())
            receipt["stages"][active] = {"status": "pass"}
            active = "transport-recovery"
            journal = temp / "stages.json"
            evidence = temp / "evidence.json"
            stages = {}
            try:
                execute(
                    [
                        str(python),
                        "-B",
                        str(Path(__file__).with_name("run_contract.py")),
                        "--bridge",
                        str(bridge),
                        "--pipeline",
                        str(roots["pipeline"]),
                        "--out",
                        str(evidence),
                        "--stages",
                        str(journal),
                    ],
                    env=env,
                    cwd=temp,
                    timeout=180,
                )
            finally:
                if journal.exists():
                    stages = json.loads(journal.read_text())
                    if set(stages) != set(STAGES):
                        raise GateError("invalid-stage-receipt")
                    receipt["stages"].update(stages)
                    active = next(
                        (name for name in STAGES if stages[name].get("status") != "pass"), active
                    )
            active = "evidence"
            if not complete(stages):
                raise GateError("incomplete-stage-evidence")
            result = json.loads(evidence.read_text())
            if not valid_evidence(result):
                raise GateError("incomplete-contract-evidence")
            receipt["evidence"] = result
            receipt["stages"][active] = {"status": "pass"}
            active = "candidate-recheck"
            verify(manifest, roots)
            receipt["stages"][active] = {"status": "pass"}
            receipt["status"] = "pass"
    except Exception as error:
        receipt["status"] = "failed"
        receipt["failure"] = str(error) if isinstance(error, GateError) else type(error).__name__
        if receipt["stages"][active].get("status") != "failed":
            receipt["stages"][active] = {"status": "failed", "reason": receipt["failure"]}
    finally:
        receipt["finishedAt"] = datetime.now(timezone.utc).isoformat()
        if receipt["status"] == "running":
            receipt["status"] = "failed"
            receipt["stages"][active] = {"status": "failed", "reason": "interrupted"}
        write_json(out, receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("pin", "run"))
    parser.add_argument("--collector", type=Path, required=True)
    parser.add_argument("--pipeline", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--python", type=Path)
    parser.add_argument("--go", default="go")
    args = parser.parse_args()
    roots = {
        "producer": PRODUCER,
        "collector": args.collector.resolve(),
        "pipeline": args.pipeline.resolve(),
    }
    if args.action == "pin":
        outside_checkouts(args.manifest, roots)
        write_json(args.manifest, pin(roots))
        return 0
    if not args.out or not args.python:
        parser.error("run requires --out and --python")
    if args.out.resolve() == args.manifest.resolve():
        parser.error("manifest and receipt must be separate files")
    try:
        manifest = json.loads(args.manifest.read_text())
    except (ValueError, OSError):
        manifest = None
    result = run(manifest, roots, args.python.absolute(), args.go, args.out)
    print(json.dumps({"status": result["status"], "stages": result["stages"]}))
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("candidate-contract: invalid input or unavailable prerequisite", file=sys.stderr)
        sys.exit(2)

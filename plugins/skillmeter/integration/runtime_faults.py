"""Require pristine behavior and semantic rejection of faults in temporary code copies."""
import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile

from candidate_contract import GateError, execute, outside_checkouts, snapshot
from contract_stages import write_json

PRODUCER = Path(__file__).resolve().parents[3]
# Anchors must match exactly once. Source drift requires an explicit fixture update.
FAULTS = {
    "omitted-backlog": ("producer", "plugins/skillmeter/scripts/lib/legacy-consent-migration.js",
        "const migrated = { ...cursor, scope, consentEpoch: epoch, metadataVersion: 1,",
        "const migrated = { ...cursor, offset: live.observed, prefix: live.sourceDigest, scope, consentEpoch: epoch, metadataVersion: 1,"),
    "ignored-consent": ("producer", "plugins/skillmeter/scripts/lib/transcript-delta.js",
        "const excluded = options.consent?.excluded.some(([start, end]) => committed < end && committed + raw.length > start);",
        "const excluded = false;"),
    "incompatible-reader": ("pipeline", "packages/preprocessor/src/skillbench_preprocessor/parse.py",
        'codex = any(entry.get("type") in ENVELOPES for entry in entries)',
        "codex = False"),
}


def mutate(file, before, after):
    source = file.read_text()
    if source.count(before) != 1 or before == after:
        raise GateError("mutation-anchor-mismatch")
    original = file.read_bytes()
    file.write_text(source.replace(before, after))
    return {"beforeSha256": hashlib.sha256(original).hexdigest(), "afterSha256": hashlib.sha256(file.read_bytes()).hexdigest()}


def archive(root, revision, relative, target):
    # Extract only reviewed tracked source, never working files or virtualenvs.
    result = subprocess.run(["git", "archive", "--format=zip", revision, "--", relative], cwd=root, capture_output=True, timeout=30, check=True)
    with zipfile.ZipFile(io.BytesIO(result.stdout)) as files:
        for entry in files.infolist():
            dest = (target / entry.filename).resolve()
            if not dest.is_relative_to(target.resolve()) or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                raise GateError("unsafe-archive-entry")
        files.extractall(target)


def environment():
    # No real credential/configuration paths or interpreter injection from caller.
    return {key: os.environ[key] for key in ("PATH", "TMPDIR", "SYSTEMROOT") if key in os.environ} | {"PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1", "AWS_EC2_METADATA_DISABLED": "true"}


def probe(command, cwd):
    try:
        result = json.loads(execute(command, cwd=cwd, env=environment(), timeout=30))
    except Exception as error:
        raise GateError("probe-execution-failed") from error
    if not isinstance(result, dict) or set(result) != {"status", "reason"}:
        raise GateError("invalid-probe-result")
    return result


def require_pair(baseline, mutant, scenario):
    if baseline != {"status": "pass", "reason": "preserved"}:
        raise GateError("baseline-invariant-failed")
    if mutant != {"status": "violation", "reason": scenario}:
        raise GateError("runtime-fault-not-detected")


def run(pipeline, python, out, producer=PRODUCER):
    roots = {"producer": producer.resolve(), "pipeline": pipeline.resolve()}
    outside_checkouts(out, roots)
    result = {"version": 1, "kind": "runtime-fault-gate", "status": "failed", "startedAt": datetime.now(timezone.utc).isoformat(), "results": []}
    write_json(out, result)  # Invalidate previous success before inspecting inputs.
    try:
        pins = {name: snapshot(name, root) for name, root in roots.items()}
        result["revisions"] = {name: pin["revision"] for name, pin in pins.items()}
        contract = json.loads((producer / "compatibility/contract.json").read_text())
        result["contractSha256"] = json.loads(execute(["node", str(producer / ".github/scripts/compatibility-contract.cjs")], env=environment()))["contractSha256"]
        if set(contract["requiredCases"]["runtimeFaults"]) != set(FAULTS):
            raise GateError("runtime-fault-matrix-mismatch")
        with tempfile.TemporaryDirectory(prefix="runtime-faults-") as temporary:
            temp = Path(temporary)
            for scenario in contract["requiredCases"]["runtimeFaults"]:
                name, relative, before, after = FAULTS[scenario]
                runtime = temp / scenario
                runtime.mkdir()
                selected = "plugins/skillmeter/scripts" if name == "producer" else "packages/preprocessor/src"
                archive(roots[name], pins[name]["revision"], selected, runtime)
                pristine = runtime / "pristine"
                pristine.mkdir()
                if name == "producer":
                    command = ["node", str(producer / "test-support/runtime-fault-probe.cjs"), str(runtime), str(pristine), scenario]
                else:
                    command = [str(python), "-B", str(producer / "test-support/reader-fault-probe.py"), str(runtime)]
                baseline = probe(command, pristine)
                if baseline != {"status": "pass", "reason": "preserved"}:
                    raise GateError("baseline-invariant-failed")
                mutation = mutate(runtime / relative, before, after)
                fault_state = runtime / "fault-state"
                fault_state.mkdir()
                if name == "producer":
                    command[-2] = str(fault_state)
                mutant = probe(command, fault_state)
                require_pair(baseline, mutant, scenario)
                result["results"].append({"scenario": scenario, "status": "pass", "baseline": "pass", "mutant": "detected", "reason": scenario, "mutation": mutation})
        if pins != {name: snapshot(name, root) for name, root in roots.items()}:
            raise GateError("candidate-changed-during-fault-check")
        result["status"] = "pass"
    except Exception as error:
        result["reason"] = str(error) if isinstance(error, GateError) else "fault-runner-failed"
    result["finishedAt"] = datetime.now(timezone.utc).isoformat()
    write_json(out, result)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--pipeline", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    try:
        receipt = run(args.pipeline, args.python, args.out)
    except Exception:
        receipt = {"status": "failed", "reason": "invalid-fault-output"}
    print(json.dumps(receipt))
    raise SystemExit(0 if receipt["status"] == "pass" else 1)

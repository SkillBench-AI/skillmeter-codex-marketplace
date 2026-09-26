"""Regression checks for semantic mutation detection without private repositories."""
import os
import json
import sys
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from candidate_contract import GateError
import runtime_faults as faults


class RuntimeFaultTests(unittest.TestCase):
    def test_mutation_requires_one_exact_anchor(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / "runtime.js"
            for contents in ("missing", "anchor anchor"):
                file.write_text(contents)
                with self.assertRaisesRegex(GateError, "mutation-anchor-mismatch"):
                    faults.mutate(file, "anchor", "changed")
                self.assertEqual(file.read_text(), contents)
            file.write_text("anchor")
            hashes = faults.mutate(file, "anchor", "changed")
            self.assertNotEqual(hashes["beforeSha256"], hashes["afterSha256"])

    def test_only_expected_semantic_failure_counts(self):
        baseline = {"status": "pass", "reason": "preserved"}
        violation = {"status": "violation", "reason": "omitted-backlog"}
        faults.require_pair(baseline, violation, "omitted-backlog")
        for bad in (baseline, {"status":"error","reason":"probe-error"}, {"status":"violation","reason":"ignored-consent"}, {"status":"violation","reason":"omitted-backlog","ignored":True}):
            with self.assertRaisesRegex(GateError, "runtime-fault-not-detected"):
                faults.require_pair(baseline, bad, "omitted-backlog")
        with self.assertRaisesRegex(GateError, "baseline-invariant-failed"):
            faults.require_pair(violation, violation, "omitted-backlog")

    def test_caller_injection_and_credentials_are_not_forwarded(self):
        with patch.dict(os.environ, {key:"private" for key in ("NODE_OPTIONS","PYTHONPATH","AWS_PROFILE","OPENAI_API_KEY","HTTPS_PROXY","HOME","CODEX_HOME")}):
            env = faults.environment()
        self.assertNotIn("private", env.values())

    def test_runtime_probes_detect_actual_backlog_and_consent_mutations(self):
        for scenario in ("omitted-backlog", "ignored-consent"):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as temp:
                runtime = Path(temp)
                source = faults.PRODUCER / "plugins/skillmeter/scripts"
                shutil.copytree(source, runtime / "plugins/skillmeter/scripts")
                pristine = runtime / "pristine"
                pristine.mkdir()
                command = ["node", str(faults.PRODUCER / "test-support/runtime-fault-probe.cjs"), str(runtime), str(pristine), scenario]
                baseline = faults.probe(command, pristine)
                _, relative, before, after = faults.FAULTS[scenario]
                faults.mutate(runtime / relative, before, after)
                fault_state = runtime / "fault-state"
                fault_state.mkdir()
                command[-2] = str(fault_state)
                mutant = faults.probe(command, fault_state)
                faults.require_pair(baseline, mutant, scenario)

    def test_invalid_candidate_replaces_stale_success(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            out = root / "receipt.json"
            out.write_text('{"status":"pass"}')
            receipt = faults.run(root / "missing-pipeline", Path(sys.executable), out, producer=root / "missing-producer")
            self.assertEqual(receipt["status"], "failed")
            self.assertEqual(json.loads(out.read_text())["status"], "failed")
            self.assertNotIn(str(root), out.read_text())

    def test_output_cannot_modify_a_source_checkout(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            producer = root / "producer"
            producer.mkdir()
            out = producer / "keep.json"
            out.write_text('{"keep":true}')
            with self.assertRaisesRegex(GateError, "outside-checkouts"):
                faults.run(root / "pipeline", Path(sys.executable), out, producer=producer)
            self.assertEqual(out.read_text(), '{"keep":true}')

    def test_process_error_is_not_a_detected_fault(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(GateError, "probe-execution-failed"):
                faults.probe(["node", "-e", "process.exit(1)"], Path(temp))


if __name__ == "__main__":
    unittest.main()

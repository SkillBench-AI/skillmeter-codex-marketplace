"""Runner boundary tests use only synthetic Git trees and stdlib dependencies."""

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import candidate_contract as candidate
from contract_stages import STAGES, StageResults, complete


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.roots = {}
        for name, files in candidate.INPUTS.items():
            root = self.root / name
            root.mkdir()
            self.roots[name] = root
            for file in files:
                target = root / file
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("synthetic\n")
            self.git(root, "init", "-q")
            self.git(root, "add", ".")
            self.git(
                root,
                "-c",
                "user.name=Synthetic",
                "-c",
                "user.email=synthetic@example.invalid",
                "commit",
                "-qm",
                "fixture",
            )
        self.manifest = candidate.pin(self.roots)

    def git(self, root, *args):
        subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)

    def test_clean_pin_contains_no_paths_and_changed_revision_fails(self):
        candidate.verify(self.manifest, self.roots)
        self.assertTrue(candidate.valid_manifest(self.manifest))
        self.assertNotIn(str(self.root), json.dumps(self.manifest))
        self.git(
            self.roots["collector"],
            "-c",
            "user.name=Synthetic",
            "-c",
            "user.email=synthetic@example.invalid",
            "commit",
            "--allow-empty",
            "-qm",
            "changed",
        )
        with self.assertRaisesRegex(candidate.GateError, "candidate-mismatch"):
            candidate.verify(self.manifest, self.roots)

    def test_dirty_and_untracked_sources_block(self):
        root = self.roots["collector"]
        (root / "go.mod").write_text("modified\n")
        with self.assertRaisesRegex(candidate.GateError, "dirty-checkout"):
            candidate.verify(self.manifest, self.roots)
        self.git(root, "restore", "go.mod")
        (root / "unexpected.go").write_text("synthetic")
        with self.assertRaisesRegex(candidate.GateError, "dirty-checkout"):
            candidate.verify(self.manifest, self.roots)

    def test_nested_checkout_and_in_tree_receipt_rejected(self):
        with self.assertRaisesRegex(candidate.GateError, "checkout-root-required"):
            candidate.snapshot("producer", self.roots["producer"] / "plugins")
        with self.assertRaisesRegex(candidate.GateError, "outside-checkouts"):
            candidate.outside_checkouts(self.roots["pipeline"] / "receipt.json", self.roots)

    def test_bad_manifest_cannot_preserve_stale_success_or_echo_contents(self):
        out = self.root / "receipt.json"
        out.write_text('{"status":"pass"}')
        result = candidate.run(
            {"secret": "synthetic-private-value"},
            self.roots,
            Path(sys.executable),
            "missing-go",
            out,
        )
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["stages"]["candidate"]["reason"], "invalid-manifest")
        self.assertEqual(json.loads(out.read_text())["status"], "failed")
        self.assertNotIn("synthetic-private-value", out.read_text())

    def test_unreadable_manifest_cli_replaces_previous_pass(self):
        out = self.root / "receipt.json"
        out.write_text('{"status":"pass"}')
        result = subprocess.run(
            [
                sys.executable,
                "-B",
                str(Path(candidate.__file__)),
                "run",
                "--collector",
                str(self.roots["collector"]),
                "--pipeline",
                str(self.roots["pipeline"]),
                "--manifest",
                str(self.root / "absent.json"),
                "--out",
                str(out),
                "--python",
                sys.executable,
            ],
            capture_output=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(out.read_text())["status"], "failed")

    def test_closed_manifest_schema_and_hashes(self):
        for change in [
            lambda m: m.update(version=True),
            lambda m: m.update(extra="unexpected"),
            lambda m: m["components"]["pipeline"].update(revision="main"),
            lambda m: m["components"]["collector"]["inputs"].update({"go.mod": "wrong"}),
        ]:
            bad = copy.deepcopy(self.manifest)
            change(bad)
            self.assertFalse(candidate.valid_manifest(bad))

    def test_environment_excludes_credentials_injection_and_real_home(self):
        with patch.dict(
            os.environ,
            {
                "AWS_PROFILE": "private",
                "AWS_SECRET_ACCESS_KEY": "private",
                "OPENAI_API_KEY": "private",
                "NODE_OPTIONS": "private",
                "PYTHONPATH": "private",
                "PYTHONOPTIMIZE": "1",
                "HTTPS_PROXY": "private",
            },
        ):
            env = candidate.runtime_environment(self.roots["pipeline"], self.root)
        self.assertNotIn("private", env.values())
        self.assertNotIn("PYTHONOPTIMIZE", env)
        self.assertEqual(env["HOME"], str(self.root))

    def test_failed_command_does_not_disclose_stderr(self):
        with self.assertRaisesRegex(candidate.GateError, "^command-failed$"):
            candidate.execute(
                [
                    sys.executable,
                    "-c",
                    'import sys; sys.stderr.write("synthetic-private-value"); sys.exit(1)',
                ]
            )


class StageTests(unittest.TestCase):
    def test_truthy_flags_and_mismatched_counts_cannot_pass_final_gate(self):
        result = {
            "syntheticOnly": True,
            "backendDashboard": False,
            "independentRecordOracle": True,
            "independentCanonicalOracle": True,
            "storageFrameValidated": True,
            "records": 2,
            "recordIntegrity": {
                "status": "pass",
                "issues": [],
                "expectedRecords": 2,
                "observedRecords": 2,
            },
            "analyzerReport": {"schemaValidated": True},
        }
        self.assertTrue(candidate.valid_evidence(result))
        for change in [
            lambda r: r["analyzerReport"].update(schemaValidated="false"),
            lambda r: r["recordIntegrity"].update(observedRecords=1),
            lambda r: r.update(records=0),
            lambda r: r.pop("storageFrameValidated"),
        ]:
            bad = copy.deepcopy(result)
            change(bad)
            self.assertFalse(candidate.valid_evidence(bad))

    def test_failure_retains_passes_and_later_stages_remain_not_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary) / "stages.json"
            stages = StageResults(out)
            stages.start(STAGES[0])
            stages.passed()
            stages.start(STAGES[1])
            stages.failed("AssertionError")
            result = json.loads(out.read_text())
            self.assertEqual(result[STAGES[0]]["status"], "pass")
            self.assertEqual(result[STAGES[1]]["status"], "failed")
            self.assertEqual(result[STAGES[2]]["status"], "not-run")
            self.assertFalse(complete(result))

    def test_missing_running_or_unknown_stage_is_not_complete(self):
        result = {name: {"status": "pass"} for name in STAGES}
        self.assertTrue(complete(result))
        for bad in [
            {},
            {**result, "unknown": {"status": "pass"}},
            {**result, STAGES[0]: {"status": "running"}},
            {**result, STAGES[0]: {"status": "not-run"}},
        ]:
            self.assertFalse(complete(bad))


if __name__ == "__main__":
    unittest.main()

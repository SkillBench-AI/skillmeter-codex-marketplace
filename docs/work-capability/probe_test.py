"""Boundary tests for the passive hook, using only temporary synthetic state."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("probe", HERE / "probe.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.evidence = self.root / "evidence"
        self.evidence.mkdir(mode=0o700)
        self.config = {"workspace":str(self.workspace), "evidence_dir":str(self.evidence), "expires_at":time.time()+3600}
        self.rows = [json.loads(line) for line in (HERE / "fixture/rollout.jsonl").read_text().splitlines()]
        self.rows[0]["payload"]["cwd"] = str(self.workspace)
        self.rows[1]["payload"]["content"][0]["text"] += " " + probe.MARKERS["initial"]
        self.source = self.root / "rollout.jsonl"
        self.save()
        self.event = {"cwd":str(self.workspace), "session_id":self.rows[0]["payload"]["id"],
                      "hook_event_name":"UserPromptSubmit", "prompt":probe.MARKERS["initial"], "transcript_path":str(self.source)}

    def save(self):
        self.source.write_text("".join(json.dumps(r)+"\n" for r in self.rows))

    def emitted(self):
        p = self.evidence / "events.jsonl"
        return [json.loads(line) for line in p.read_text().splitlines()] if p.exists() else []

    def test_selected_fixture_readable_without_text_export(self):
        probe.handle(self.event, self.config)
        out = self.emitted()[0]["transcript"]
        self.assertEqual(out["outcome"], "readable-jsonl")
        self.assertEqual(out["linked_results"], 4)
        self.assertEqual(out["malformed_lines"], 0)
        raw = (self.evidence / "events.jsonl").read_text()
        for secret in ["fixture@example.com", "SYNTHETIC-NOT-A-CREDENTIAL", "Read source.csv", str(self.source), self.event["session_id"]]:
            self.assertNotIn(secret, raw)

    def test_other_workspace_even_with_marker_is_ignored(self):
        probe.handle({**self.event,"cwd":str(self.root)}, self.config)
        self.assertEqual(list(self.evidence.iterdir()), [])

    def test_no_marker_or_wrong_event_does_not_arm(self):
        for patch in [{"prompt":"hello"}, {"hook_event_name":"Stop"}]:
            probe.handle({**self.event,**patch}, self.config)
        self.assertEqual(list(self.evidence.iterdir()), [])

    def test_second_session_cannot_rebind(self):
        probe.handle(self.event, self.config)
        probe.handle({**self.event,"session_id":"different-session"}, self.config)
        self.assertEqual(len(self.emitted()), 1)

    def test_explicit_task_cannot_be_replaced_even_without_binding(self):
        config = {**self.config,"required_session_hash":probe.digest(self.event["session_id"])}
        probe.handle({**self.event,"session_id":"another-task"}, config)
        self.assertEqual(list(self.evidence.iterdir()), [])

    def test_preselected_task_accepts_followup_without_rearming(self):
        config = {**self.config,"required_session_hash":probe.digest(self.event["session_id"])}
        (self.evidence / "selected-session.json").write_text(json.dumps({"session_hash":config["required_session_hash"]}))
        probe.handle({**self.event,"prompt":probe.MARKERS["hookcheck"]}, config)
        self.assertEqual(self.emitted()[0]["transcript"]["outcome"], "readable-jsonl")

    def test_explicit_task_still_requires_expected_cwd(self):
        config = {**self.config,"required_session_hash":probe.digest(self.event["session_id"])}
        probe.handle({**self.event,"cwd":str(self.root)}, config)
        self.assertEqual(list(self.evidence.iterdir()), [])

    def test_expired_probe_is_inert(self):
        probe.handle(self.event, {**self.config,"expires_at":0})
        self.assertEqual(list(self.evidence.iterdir()), [])

    def test_no_transcript_path_is_explicit(self):
        probe.handle({**self.event,"transcript_path":None}, self.config)
        self.assertEqual(self.emitted()[0]["transcript"]["outcome"], "no-transcript-path")

    def test_mismatched_source_never_scans_messages(self):
        self.rows[0]["payload"]["cwd"] = "/private/other-work"
        self.save()
        probe.handle(self.event, self.config)
        self.assertEqual(self.emitted()[0]["transcript"], {"outcome":"source-identity-mismatch"})

    def test_symlink_source_rejected(self):
        link = self.root / "link.jsonl"
        link.symlink_to(self.source)
        probe.handle({**self.event,"transcript_path":str(link)}, self.config)
        self.assertEqual(self.emitted()[0]["transcript"]["outcome"], "unreadable-or-invalid-metadata")

    def test_partial_tail_reports_gap(self):
        with self.source.open("a") as f: f.write('{"payload":')
        probe.handle(self.event, self.config)
        out = self.emitted()[0]["transcript"]
        self.assertEqual(out["malformed_lines"], 1)
        self.assertFalse(out["newline_terminated"])

    def test_size_limit_bounds_transcript_read(self):
        with self.source.open("a") as f: f.write("x" * probe.LIMIT)
        probe.handle(self.event, self.config)
        self.assertEqual(self.emitted()[0]["transcript"]["outcome"], "size-limit")

    def test_excluded_prefix_not_counted(self):
        self.rows.insert(1, copy.deepcopy(self.rows[2]))
        self.rows[1]["payload"]["call_id"] = "pre-consent-call"
        self.save()
        probe.handle(self.event, self.config)
        self.assertEqual(self.emitted()[0]["transcript"]["calls"], 4)

    def test_non_json_start_reports_unsupported(self):
        self.source.write_text(json.dumps({"type":"paginated-history"})+"\n")
        probe.handle(self.event, self.config)
        self.assertEqual(self.emitted()[0]["transcript"]["outcome"], "unsupported-start-record")


if __name__ == "__main__":
    unittest.main(verbosity=2)

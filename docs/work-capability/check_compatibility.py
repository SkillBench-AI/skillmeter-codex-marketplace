"""Offline characterization of ONE synthetic fixture, not a live Work test.

Run with Python >=3.14 and --pipeline pointing to the pinned candidate checkout.
Only the pure sanitizer and parser are called; no logger, credentials or uploads.
"""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import unittest

HERE = Path(__file__).resolve().parent
EXPECTED = json.loads((HERE / "fixture/expected.json").read_text())
KEY = "transcripts/SYNTHETIC-WORK-DEVICE/2026-09-15/work-capability-synthetic-001.jsonl"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pipeline", type=Path, required=True)
    args = parser.parse_args()
    if sys.version_info < (3, 14):
        parser.error("The current preprocessor requires Python 3.14; no dependency installation is performed.")
    pipeline = args.pipeline.resolve()
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=pipeline, text=True).strip()
    if head != "fd5a75814e1622949d13eb54452251274aef5ac4":
        parser.error("Pipeline revision differs from the recorded baseline; re-review before updating the pin.")
    sys.path.insert(0, str(pipeline / "packages/preprocessor/src"))
    from skillbench_preprocessor.parse import parse_with_outcome
    from skillbench_preprocessor.structured import structured_session
    from skillbench_preprocessor.flatten import flatten_session

    raw = (HERE / "fixture/rollout.jsonl").read_bytes()
    clean = subprocess.check_output(["node", str(HERE / "sanitize-fixture.cjs")])

    class Compatibility(unittest.TestCase):
        def test_fixture_arithmetic_matches_source(self):
            with (HERE / "fixture/source.csv").open() as f:
                rows = list(csv.DictReader(f))
            self.assertEqual(sum(int(r["minutes"]) for r in rows), EXPECTED["initial_total_minutes"])
            self.assertEqual(sum(int(r["minutes"]) for r in rows if r["activity"] != "Prepare slides"), EXPECTED["revised_total_minutes"])

        def test_sanitized_messages_and_linked_tools(self):
            parsed = parse_with_outcome(clean, KEY)
            self.assertIsNotNone(parsed.session)
            self.assertFalse(parsed.diagnostic.actionable)
            out = structured_session(parsed.session)
            self.assertEqual(out["session_id"], EXPECTED["fixture_id"])
            self.assertEqual(out["source_path"], KEY)
            self.assertEqual(len(out["messages"]), EXPECTED["expected_normalized_messages"])
            blocks = [b for m in out["messages"] for b in m["content"]]
            calls = [b for b in blocks if b["type"] == "tool_use"]
            results = [b for b in blocks if b["type"] == "tool_result"]
            self.assertEqual([b["id"] for b in calls], EXPECTED["expected_tool_ids"])
            self.assertEqual([b["name"] for b in calls], EXPECTED["expected_tool_names"])
            self.assertEqual([b["tool_use_id"] for b in results], EXPECTED["expected_tool_ids"])
            self.assertEqual(results[0]["content"], (HERE / "fixture/source.csv").read_text())
            self.assertEqual([results[i]["content"] for i in [1, 3]], ["60\n", "30\n"])
            texts = [b["text"] for b in blocks if b["type"] == "text"]
            self.assertEqual(len(texts), EXPECTED["expected_authored_messages"])
            self.assertEqual(texts[-1], "The revised total is 30 minutes.")
            self.assertTrue(all(m["created_at"] for m in out["messages"]))

        def test_current_work_surface_gap_is_explicit(self):
            out = structured_session(parse_with_outcome(clean, KEY).session)
            # Characterizes the existing gap; does NOT assert desired Work support.
            self.assertEqual(out["agent"], "codex")
            self.assertNotIn("surface", out)
            self.assertNotIn("execution_location", out)
            self.assertNotIn("synthetic-work-hypothesis", json.dumps(out))

        def test_unknown_record_warns_without_discarding_valid_messages(self):
            unknown = {"type":"response_item", "payload":{"type":"synthetic_unknown_work_record"}}
            parsed = parse_with_outcome(clean + json.dumps(unknown).encode() + b"\n", KEY)
            self.assertIsNotNone(parsed.session)
            self.assertEqual(parsed.diagnostic.unsupported_records, 1)
            self.assertTrue(parsed.diagnostic.actionable)
            self.assertFalse(parsed.diagnostic.blocks_report)

        def test_truncated_tail_is_corruption_not_clean_coverage(self):
            parsed = parse_with_outcome(clean + b'{"type":"response_item",', KEY)
            self.assertGreater(parsed.diagnostic.malformed_lines, 0)
            self.assertTrue(parsed.diagnostic.blocks_report)

        def test_missing_result_remains_incomplete(self):
            rows = [json.loads(line) for line in clean.splitlines()]
            rows = [r for r in rows if not (r["payload"].get("call_id") == "work-revise" and r["payload"]["type"] == "function_call_output")]
            parsed = parse_with_outcome(b"\n".join(json.dumps(r).encode() for r in rows), KEY)
            self.assertEqual(parsed.diagnostic.incomplete_tools, 1)

        def test_legacy_flat_projection_is_not_full_tool_capture(self):
            out = flatten_session(parse_with_outcome(clean, KEY).session)
            self.assertTrue(all(isinstance(m["content"], str) for m in out["messages"]))
            self.assertNotIn("tool_use", json.dumps(out))

        def test_raw_fixture_never_mutated(self):
            self.assertEqual((HERE / "fixture/rollout.jsonl").read_bytes(), raw)
            self.assertNotIn(b"SYNTHETIC-NOT-A-CREDENTIAL", clean)

    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Compatibility))
    print(json.dumps({"evidence":"synthetic-only", "pipeline_head":head,
                      "fixture_sha256":hashlib.sha256(raw).hexdigest(),
                      "sanitized_sha256":hashlib.sha256(clean).hexdigest(),
                      "checks":result.testsRun, "passed":result.wasSuccessful()}))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())

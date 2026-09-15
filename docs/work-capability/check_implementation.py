"""Synthetic local queue -> sanitizer -> candidate preprocessor acceptance.

Requires Python 3.14 and --pipeline <Work candidate checkout>. No credentials,
private transcript, network, installed hooks or analysis model is used.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys

p = argparse.ArgumentParser(description=__doc__)
p.add_argument("--pipeline", type=Path, required=True)
a = p.parse_args()
sys.path.insert(0, str(a.pipeline.resolve() / "packages/preprocessor/src"))
from skillbench_preprocessor.parse import parse_with_outcome
from skillbench_preprocessor.structured import structured_session

body = subprocess.check_output(["node", str(Path(__file__).with_name("stage-implementation-fixture.cjs"))])
assert b"EXCLUDED-" not in body and b"SYNTHETIC-OPAQUE-COMMAND" not in body
assert b"/synthetic/non-repository" not in body
result = parse_with_outcome(body, "transcripts/SYNTHETIC/2026-09-15/work.jsonl")
assert not result.diagnostic.actionable and result.diagnostic.incomplete_tools == 0
out = structured_session(result.session)
assert out["session_id"] == "synthetic-work-task"
assert out["agent"] == "codex" and out["surface"] == "chatgpt_work"
assert out["originator"] == "codex_work_desktop" and "execution_location" not in out
assert len(out["messages"]) == 3
blocks = [b for m in out["messages"] for b in m["content"]]
calls = [b for b in blocks if b["type"] == "tool_use"]
results = [b for b in blocks if b["type"] == "tool_result"]
assert len(calls) == len(results) == 1
assert calls[0]["id"] == results[0]["tool_use_id"] == "outer-1"
assert calls[0]["name"] == "exec" and results[0]["content"] == "60 minutes"
assert blocks[-1]["text"] == "The total is 60 minutes."
print(json.dumps({"evidence": "synthetic-only", "passed": True, "messages": 3, "outer_tool_pairs": 1, "delivery": "disabled"}))

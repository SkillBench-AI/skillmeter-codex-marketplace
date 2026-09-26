"""Parse synthetic wire records using a selected temporary reader copy."""
import json
from pathlib import Path
import sys


def deny_network(event, _args):
    if event in {"socket.connect", "socket.getaddrinfo", "subprocess.Popen"}:
        raise RuntimeError("external-access-denied")


sys.addaudithook(deny_network)
try:
    runtime = Path(sys.argv[1]).resolve()
    sys.path.insert(0, str(runtime / "packages/preprocessor/src"))
    import skillbench_preprocessor.parse as parser

    if not Path(parser.__file__).resolve().is_relative_to(runtime):
        raise RuntimeError("wrong-reader-import")
    records = [
        {"type": "session_meta", "payload": {"id": "fault-fixture", "cwd": "/synthetic", "source": "cli", "originator": "codex_cli_rs"}},
        {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Synthetic request"}]}},
        {"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Synthetic response"}]}},
    ]
    wire = ("\n".join(map(json.dumps, records)) + "\n").encode()
    result = parser.parse_transcript(wire, "transcripts/FIXTURE/2026-01-01/fault-fixture.jsonl")
    if result is None:
        print(json.dumps({"status": "violation", "reason": "incompatible-reader"}))
    elif result.agent == "codex" and result.session_id == "fault-fixture" and [m.role for m in result.messages] == ["user", "assistant"] and [[b.get("text") for b in m.content] for m in result.messages] == [["Synthetic request"], ["Synthetic response"]]:
        print(json.dumps({"status": "pass", "reason": "preserved"}))
    else:
        print(json.dumps({"status": "error", "reason": "unexpected-probe-result"}))
except Exception:
    print(json.dumps({"status": "error", "reason": "probe-error"}))
    sys.exit(1)

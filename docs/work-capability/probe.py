"""Bounded local Work capability hook. No network, credentials or transcript export.

Only an exact cwd + marker can select one session. Evidence contains counts and
known synthetic markers, never arbitrary prompt/tool text or transcript paths.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import time

EVENTS = {"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "Interrupt", "SessionEnd"}
KINDS = {"session_meta", "turn_context", "response_item", "event_msg", "compacted", "world_state", "token_usage_record"}
SUBTYPES = {"message", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "user_message", "agent_message", "reasoning", "web_search_call", "task_started", "task_complete", "turn_aborted"}
MARKERS = {"initial": "WORK-PROBE-20260915-A", "followup": "WORK-PROBE-20260915-B", "total60": "60", "total30": "30"}
LIMIT = 2 * 1024 * 1024


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()[:24]


def read_regular(path, limit):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError("noncanonical")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("not-regular")
        data = bytearray()
        while len(data) <= limit:
            chunk = os.read(fd, min(65536, limit + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        return bytes(data)
    finally:
        os.close(fd)


def transcript_shape(source, session, workspace):
    if not isinstance(source, str) or not source:
        return {"outcome": "no-transcript-path"}
    try:
        # Validate only the first bounded metadata line before scanning content.
        prefix = read_regular(source, 65536).split(b"\n", 1)[0]
        meta = json.loads(prefix)
        payload = meta.get("payload", {})
        if meta.get("type") != "session_meta":
            return {"outcome": "unsupported-start-record"}
        if payload.get("id") != session or payload.get("cwd") != workspace:
            return {"outcome": "source-identity-mismatch"}
        raw = read_regular(source, LIMIT)
        if len(raw) > LIMIT:
            return {"outcome": "size-limit", "limit_bytes": LIMIT}
        current = json.loads(raw.split(b"\n", 1)[0])
        if current.get("type") != "session_meta" or current.get("payload", {}).get("id") != session or current.get("payload", {}).get("cwd") != workspace:
            return {"outcome": "source-identity-mismatch"}
        rows, counts, malformed, markers, calls, results = [], {}, 0, set(), set(), set()
        for line in raw.splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
                if not isinstance(row, dict):
                    raise ValueError("not-object")
                rows.append(row)
            except (ValueError, UnicodeError):
                malformed += 1
        armed = False
        for row in rows:
            payload = row.get("payload")
            if not isinstance(payload, dict):
                malformed += 1
                continue
            # Everything preceding the selected synthetic user prompt is excluded.
            if not armed:
                candidate = ((row.get("type") == "response_item" and payload.get("type") == "message" and payload.get("role") == "user") or
                             (row.get("type") == "event_msg" and payload.get("type") == "user_message"))
                armed = candidate and MARKERS["initial"] in json.dumps(payload)
            if not armed:
                continue
            kind = row.get("type") if row.get("type") in KINDS else "other"
            subtype = payload.get("type") if payload.get("type") in SUBTYPES else "other"
            label = kind + "/" + subtype
            counts[label] = counts.get(label, 0) + 1
            text = json.dumps(payload)
            markers.update(name for name, token in MARKERS.items() if token in text)
            call_id = payload.get("call_id")
            if isinstance(call_id, str):
                if subtype in {"function_call", "custom_tool_call"}:
                    calls.add(digest(call_id))
                elif subtype in {"function_call_output", "custom_tool_call_output"}:
                    results.add(digest(call_id))
        return {"outcome": "readable-jsonl" if armed else "awaiting-transcript-marker",
                "bytes": len(raw), "record_counts": counts, "malformed_lines": malformed,
                "newline_terminated": raw.endswith(b"\n"), "synthetic_markers": sorted(markers),
                "calls": len(calls), "results": len(results), "linked_results": len(calls & results)}
    except (OSError, ValueError, TypeError, AttributeError):
        return {"outcome": "unreadable-or-invalid-metadata"}


def handle(event, config):
    if time.time() >= config["expires_at"]:
        return
    workspace = config["workspace"]
    if event.get("cwd") != workspace or str(Path(workspace).resolve()) != workspace:
        return
    if event.get("hook_event_name") not in EVENTS:
        return
    session = event.get("session_id")
    if not isinstance(session, str) or not session or len(session) > 256:
        return
    state = Path(config["evidence_dir"])
    if not state.is_dir() or state.is_symlink() or str(state.resolve()) != str(state):
        return
    binding = state / "selected-session.json"
    selected = {"session_hash": digest(session)}
    if not binding.exists():
        if event["hook_event_name"] != "UserPromptSubmit" or MARKERS["initial"] not in str(event.get("prompt", "")):
            return
        try:
            fd = os.open(binding, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(selected, f)
        except FileExistsError:
            pass
    try:
        if json.loads(read_regular(str(binding), 4096)) != selected:
            return
    except (OSError, ValueError):
        return
    output = state / "events.jsonl"
    if output.exists() and output.stat().st_size > LIMIT:
        return
    evidence = {"time": time.time(), "event": event["hook_event_name"], **selected,
                "transcript": transcript_shape(event.get("transcript_path"), session, workspace)}
    # One append syscall per event. No trust/config writes and no model-visible output.
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, (json.dumps(evidence) + "\n").encode())
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(256 * 1024 + 1)
        if len(raw) <= 256 * 1024:
            handle(json.loads(raw), json.loads(read_regular(sys.argv[1], 8192)))
    except Exception:
        # Capability observation is advisory. Never print private exceptions.
        pass

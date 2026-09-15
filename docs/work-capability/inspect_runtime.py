"""Read installed-app metadata and generate schemas offline, without opening history.

Print only selected public protocol fields. Does not connect to the app-server,
read user config, inspect session directories, or install anything.
"""
import json
from pathlib import Path
import plistlib
import subprocess
import tempfile

APP = Path("/Applications/ChatGPT.app/Contents")
BINARY = APP / "Resources/codex"
info = plistlib.loads((APP / "Info.plist").read_bytes())
report = {"app": {key: info.get(key) for key in (
    "CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion")}}
report["bundled_runtime"] = subprocess.check_output([str(BINARY), "--version"], text=True).strip()
report["cli_runtime"] = subprocess.check_output(["codex", "--version"], text=True).strip()
with tempfile.TemporaryDirectory(prefix="work-capability-schema-") as tmp:
    subprocess.run([str(BINARY), "app-server", "generate-json-schema", "--out", tmp],
                   check=True, capture_output=True)
    selected = {}
    for path in Path(tmp).rglob("*.json"):
        document = json.loads(path.read_text())
        definitions = document.get("definitions", {})
        for name in ("ThreadHistoryMode", "SessionSource", "ThreadSource"):
            if name in definitions:
                selected[name] = definitions[name]
        if "Thread" in definitions:
            fields = definitions["Thread"]["properties"]
            selected["Thread_fields"] = {k: fields[k] for k in (
                "path", "historyMode", "ephemeral", "originator", "threadSource", "source", "sessionId")}
        if path.name == "ThreadReadParams.json":
            selected["ThreadRead_includeTurns"] = document["properties"]["includeTurns"]
    report["protocol_evidence"] = selected
report["limits"] = ["Schema capability only; no active account or task inspected",
                    "API schema is not proof of hook JSON or rollout storage format"]
print(json.dumps(report, indent=2))

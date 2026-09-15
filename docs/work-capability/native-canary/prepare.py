"""Populate a freshly scaffolded local canary; does not install or trust hooks."""
import json
import pathlib
import shlex
import shutil
import sys
import time

target, config_path = map(pathlib.Path, sys.argv[1:])
here = pathlib.Path(__file__).resolve().parent
source = here.parents[2] / "plugins/skillmeter"
if config_path.exists() or (target / "candidate").exists():
    raise SystemExit("Refusing to overwrite an existing canary configuration or candidate")
manifest_path = target / ".codex-plugin/plugin.json"
manifest = json.loads(manifest_path.read_text())
assert manifest["name"] == "skillmeter-work-canary"
shutil.copytree(source, target / "candidate")
shutil.copy2(here / "native-hook.cjs", target / "native-hook.cjs")
shutil.copy2(here.parent / "canary/network-guard.cjs", target / "network-guard.cjs")
manifest.pop("skills", None)
manifest["description"] = "Local-only synthetic Work canary; inactive until one task is explicitly selected."
manifest["interface"].update({
    "displayName": "SkillMeter Work Canary",
    "shortDescription": "One selected synthetic task; delivery disabled.",
    "longDescription": "Temporary native-hook test. Exact-task guard, 24-hour expiry, network blocked. Does not enable general Work telemetry.",
    "defaultPrompt": "Wait for the original telemetry task to select this synthetic canary before testing capture.",
})
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd", "Interrupt"]
hooks = {event: [{"hooks": [{"type": "command", "command": f'node "${{PLUGIN_ROOT}}/native-hook.cjs" {shlex.quote(str(config_path))} {event}', "timeout": 4, "statusMessage": "SkillMeter Work Canary: selected task only"}]}] for event in events}
(target / "hooks/hooks.json").write_text(json.dumps({"hooks": hooks}, indent=2) + "\n")
config_path.parent.mkdir(parents=True, mode=0o700)
config_path.write_text(json.dumps({
    "expiresAt": int(time.time() * 1000) + 86400000,
    "selected": None, "cwd": None, "transcript": None,
    "stateDir": str(pathlib.Path.home() / ".skillbench"),
    "pluginData": str(config_path.parent / "data"),
    "evidence": str(config_path.parent / "events.jsonl"),
}, indent=2) + "\n")
config_path.chmod(0o600)
print(json.dumps({"plugin": str(target), "config": str(config_path), "events": events, "selected": False}))

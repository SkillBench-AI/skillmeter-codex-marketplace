"""Remove only the exact hook groups recorded by this probe installation.

Preserves unrelated/changed hooks. Leaves protected local evidence for review.
"""
import json
import os
from pathlib import Path
import tempfile

root = Path.home() / ".codex"
receipt = json.loads((root / "work-capability-probe/install-receipt.json").read_text())
target = root / "hooks.json"
if target.is_symlink():
    raise SystemExit("Refusing symlink hook file")
if not target.exists():
    raise SystemExit("No user hooks.json exists; nothing removed")
before = target.read_bytes()
current = json.loads(before)
removed = 0
for event, group in receipt["groups"].items():
    groups = current.get("hooks", {}).get(event, [])
    removed += groups.count(group)
    kept = [g for g in groups if g != group]
    if kept:
        current["hooks"][event] = kept
    else:
        current.get("hooks", {}).pop(event, None)
if target.read_bytes() != before:
    raise SystemExit("Hook file changed during removal; retry after review")
if removed:
    if current == {"hooks": {}}:
        target.unlink()  # This file was absent before the probe was installed.
    else:
        fd, name = tempfile.mkstemp(prefix="work-probe-remove-", dir=root)
        with os.fdopen(fd, "w") as f:
            json.dump(current, f, indent=2)
            f.write("\n")
        os.replace(name, target)
print(f"Removed {removed} exact probe hook groups; retained all other configuration and evidence.")

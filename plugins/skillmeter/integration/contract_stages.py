"""Content-free, fail-closed stage results for the synthetic contract runner."""

import json
from pathlib import Path

STAGES = (
    "transport-recovery",
    "stored-records",
    "normalization",
    "scripted-analysis",
    "ingest-schema",
)


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


class StageResults:
    def __init__(self, path):
        self.path = path
        self.results = {name: {"status": "not-run"} for name in STAGES}
        self.active = None
        self.save()

    def save(self):
        if self.path:
            write_json(self.path, self.results)

    def start(self, name):
        if self.active or name not in self.results or self.results[name]["status"] != "not-run":
            raise ValueError("invalid-stage-transition")
        self.active = name
        self.results[name] = {"status": "running"}
        self.save()

    def passed(self):
        if self.active is None:
            raise ValueError("no-active-stage")
        self.results[self.active] = {"status": "pass"}
        self.active = None
        self.save()

    def failed(self, reason):
        if self.active:
            self.results[self.active] = {"status": "failed", "reason": reason}
            self.active = None
        self.save()


def complete(results):
    return (
        isinstance(results, dict)
        and set(results) == set(STAGES)
        and all(results[name] == {"status": "pass"} for name in STAGES)
    )

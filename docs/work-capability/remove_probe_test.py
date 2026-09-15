"""Verify removal preserves unrelated hook definitions using disposable files."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parent / "remove_probe.py"


class RemovalTests(unittest.TestCase):
    def run_case(self, extra, expected):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp).resolve()
            root = home / ".codex"
            (root / "work-capability-probe").mkdir(parents=True)
            group = {"hooks":[{"command":"synthetic probe command", "type":"command"}]}
            receipt = {"groups":{"Stop":group}}
            (root / "work-capability-probe/install-receipt.json").write_text(json.dumps(receipt))
            target = root / "hooks.json"
            target.write_text(json.dumps({"hooks":{"Stop":[group, *extra]}}))
            with patch.object(Path, "home", return_value=home), contextlib.redirect_stdout(io.StringIO()):
                runpy.run_path(str(SCRIPT), run_name="__main__")
            if expected is None:
                self.assertFalse(target.exists())
            else:
                self.assertEqual(json.loads(target.read_text()), expected)
            self.assertTrue((root / "work-capability-probe/install-receipt.json").exists())

    def test_remove_only_created_file_when_empty(self):
        self.run_case([], None)

    def test_keep_unrelated_hook(self):
        other = {"hooks":[{"command":"unrelated command", "type":"command"}]}
        self.run_case([other], {"hooks":{"Stop":[other]}})

    def test_keep_changed_probe_definition(self):
        changed = {"hooks":[{"command":"synthetic probe command edited", "type":"command"}]}
        self.run_case([changed], {"hooks":{"Stop":[changed]}})


if __name__ == "__main__":
    unittest.main(verbosity=2)

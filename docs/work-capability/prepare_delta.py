"""Extract a committed Work-only patch and check it against a foundation.

Uses only local Git objects and a temporary export. Does not fetch, change a
checkout, install a plugin, or read credentials/transcripts. Python 3.12+.
Exit 0: patch applies; 2: reconciliation required; other errors are fatal.
Patch applicability is not runtime compatibility or approval to ship.
"""
import argparse
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--base", required=True, help="parent before the Work delta")
    parser.add_argument("--candidate", required=True, help="committed Work candidate")
    parser.add_argument("--target", required=True, help="foundation to check, e.g. origin/main")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--scope", nargs="+", required=True, help="repo-relative product/test paths")
    args = parser.parse_args()
    repo = subprocess.check_output(["git", "-C", str(args.repo.resolve()), "rev-parse", "--show-toplevel"]).decode().strip()

    def git(*arguments):
        return subprocess.check_output(["git", "-C", repo, *arguments])

    refs = {name: git("rev-parse", "--verify", ref + "^{commit}").decode().strip()
            for name, ref in (("base", args.base), ("candidate", args.candidate), ("target", args.target))}
    git("merge-base", "--is-ancestor", refs["base"], refs["candidate"])
    patch = git("diff", "--binary", refs["base"], refs["candidate"], "--", *args.scope)
    if not patch:
        raise SystemExit("No Work delta in the requested scope")
    files = git("diff", "--name-status", refs["base"], refs["candidate"], "--", *args.scope).decode().splitlines()

    with tempfile.TemporaryDirectory(prefix="work-foundation-") as directory:
        with tarfile.open(fileobj=io.BytesIO(git("archive", refs["target"]))) as archive:
            archive.extractall(directory, filter="data")
        # Keep Git from discovering a parent repository when the user's temp
        # directory happens to be inside a checkout. This is a disposable repo.
        subprocess.run(["git", "init", "--quiet", directory], check=True)
        result = subprocess.run(["git", "-C", directory, "apply", "--check", "-"],
                                input=patch, capture_output=True)
    report = {"revisions": refs, "scope": args.scope, "files": files,
              "patch_applies": result.returncode == 0,
              "diagnostics": result.stderr.decode().splitlines(),
              "runtime_compatibility": "not-established-by-this-check",
              "installed_or_uploaded": False}
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "work-only.patch").write_bytes(patch)
    (args.output / "foundation.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0 if report["patch_applies"] else 2


if __name__ == "__main__":
    raise SystemExit(main())

---
name: collect-export
description: Collect a sanitized SkillBench export from local Codex sessions.
---

Use this skill when the user wants to collect, export, or prepare SkillBench
data from Codex.

Workflow:

1. Explain that the safe shareable artifact is the sanitized export written by
   SkillBench, not the raw files in `~/.codex/sessions`.
2. Prefer an existing local `skillbench` CLI if it is already installed.
3. If the current workspace already contains a `session-collector` checkout,
   prefer using that checkout instead of cloning a new copy.
4. If neither is available, guide the user through the documented
   `session-collector` install path that best fits their machine.
5. Run the collector with the safest default that satisfies the request:
   `skillbench collect` or the equivalent local checkout command.
6. If the user wants collection limited to approved GitHub orgs, add
   `--allowed-orgs ...`.
7. Report the sanitized output path under `dist/` and remind the user that this
   sanitized export is the file intended for upload.

Guardrails:

- Never recommend uploading raw Codex session logs directly.
- Prefer the sanitized export flow even if the user asks generally about
  telemetry.
- If the user wants broader inclusion such as private or unlicensed repos, make
  that choice explicit before using the broader collection mode.

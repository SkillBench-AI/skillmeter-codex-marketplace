---
name: review-export
description: Review a sanitized SkillBench export before upload.
---

Use this skill when the user provides a sanitized SkillBench export file and
wants help understanding or validating it before upload.

Workflow:

1. Confirm that the file is a sanitized SkillBench export, typically from
   `dist/skillbench_export_sanitized_*.json`.
2. Summarize the export at a high level:
   - number of sessions
   - which agent families appear
   - major workspace or repo coverage
3. Call out anything surprising, such as missing expected workspaces or agent
   activity that looks incomplete.
4. If the user asks for a deeper read, drill into patterns without requesting
   raw session logs unless the sanitized export is insufficient.

Guardrails:

- Treat the sanitized export as the preferred review artifact.
- Avoid asking for unsanitized local session files unless the user explicitly
  wants deeper debugging.

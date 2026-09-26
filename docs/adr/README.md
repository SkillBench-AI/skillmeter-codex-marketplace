# Architectural Decision Records

Decisions that shape the SkillMeter clients are made once, in the Claude Code
plugin repository's ADR set, and adopted here by reference. Each file below
carries the same number and title as its canonical ADR, the link to it, and
only what differs in the Codex plugin. A consent, sanitization or lifecycle
change is made there first and mirrored here; this plugin never changes those
behaviours on its own.

| # | Title | Canonical status | Codex file |
|---|---|---|---|
| 001 | License token lifecycle: lifetime, refresh, and recovery | Accepted, amended 2026-09-16 | [001](001-license-token-lifecycle.md) |
| 002 | Two-stage sanitization and typed PII placeholders | Accepted, amended 2026-09-11 | [002](002-two-stage-sanitization.md) |
| 003 | Collection state visibility: notices, monitor lifecycle, and the local status record | Accepted 2026-09-25 | [003](003-collection-state-visibility.md) |
| 004 | One consent record shared by every client on a machine | Accepted 2026-09-25 | [004](004-shared-consent.md) |

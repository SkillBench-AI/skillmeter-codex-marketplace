# Collection State Visibility: Notices, Monitor Lifecycle, and the Local Status Record

**Status:** Adopted by reference, pending the canonical decision. Canonical
text: [Claude Code plugin ADR 003](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/seungho/inf-174-adr-003-collection-state-visibility/docs/adr/003-collection-state-visibility.md)
(Proposed, [PR #111](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/pull/111); the link moves to `main` when it lands).
**Tracker:** INF-174 (canonical), INF-177

## What is the same

A single local resolver decides whether collection can proceed, with no
network call in hooks (decision 1). The retry daemon exits when the client
cannot proceed without the user (decision 3). The wording rules (decision 5)
apply to every user-facing line this plugin prints.

## Differences in the Codex plugin

- Codex has no monitor notification surface. The transition notices of
  decision 2 and the SessionStart card of decision 4 have these
  counterparts here: the SessionStart explanation for an unconfigured or
  excluded repository (#48), the hook stderr lines, and `telemetry.js status`,
  which distinguishes capture policy from delivery readiness (#47) and is
  the on-demand view of decision 6.
- The local status record of decision 1 has no Codex counterpart yet. Until
  it exists, `status` derives its answer from the credential file, the
  policy files and the queue directories on each call.

## Open items

- Write the local status record in the same shape as the Claude plugin once
  ADR 003 is accepted, so a shared status view can read both.

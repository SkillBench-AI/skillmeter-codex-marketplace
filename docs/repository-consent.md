# Repository capture consent

Codex follows the explicit repository opt-in rule in Claude's
[capture policy](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/a50a38e98dc1302cb8a952adac00ee90e0d9f55a/skillmeter/scripts/lib/telemetry-policy.js).
An allowed GitHub owner makes a repository eligible; it does not enable capture.
The repository choice must be the boolean `true`. Missing or invalid choices
stay off, and explicit opt-out, scope exclusion and global pause block capture.

The existing Codex gate is adapted rather than copying Claude's complete gate:
the latter also depends on its shared policy store and license-validity check.
This change does not alter Codex's credential lifecycle or expiry behavior.

| Boundary | Codex behavior / remaining difference from Claude |
| --- | --- |
| Repository choice | Stored at the checkout's Git root in `.codex/settings.local.json`. Subdirectory commands use the same file. Separate clones and linked worktrees still need separate choices; canonical identity and the shared policy store remain follow-up work. |
| Legacy subdirectory choices | A subdirectory opt-out continues to restrict capture there. A subdirectory opt-in cannot authorize the repository. Nested Git repositories have independent choices. |
| Organization consent | Existing signed-in identity scope and optional narrowing remain. Claude's separate organization authorization record is not adopted here. |
| Revocation and queued data | Disabling a repository stops new hooks and staging. Already queued event batches may still drain; queued transcripts remain subject to the existing send-time scope check. No repository purge is added. |
| Disabled transcript intervals | No privacy cursor is added. Later authorized staging or baseline recovery can still include earlier source records. Full interval exclusion requires a separate transport change. |
| Global pause | Stops new capture and transmission while retaining queued data. Existing global controls and shared credential fields remain unchanged. |

This is a capture-gate change, not complete parity with
[Claude's collection contract](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/a50a38e98dc1302cb8a952adac00ee90e0d9f55a/skillmeter/README.md#collection-scope).
Do not present it as retroactive consent isolation or enable a new surface's
uploads on this basis. Work-specific consent and delivery are separate.

Run `node --test plugins/skillmeter/test/repository-consent-boundary.test.js`
for synthetic hook/CLI boundary tests, then `npm run check` for the full suite.
These checks do not prove native hook approval, production receipt or reporting.

# SkillMeter for Codex

SkillMeter sends repository-scoped Codex workflow and conversation telemetry to
[SkillBench](https://skillbench.com). Collection and uploads run in the background.
See the [installation and update guide](../../README.md#install) to get started.

## Sign in and controls

In Codex, ask SkillMeter to sign you in, sign you out, or check whether the
current repository is in scope. The bundled skills are listed below.

For terminal commands, set `PLUGIN_ROOT` to the **Installed plugin root** printed
by `codex plugin add`. For a default 0.5.1 installation:

```sh
export PLUGIN_ROOT="$HOME/.codex/plugins/cache/skillbench/skillmeter/0.5.1"
```

Run project controls from the repository you want to configure:

| Task | Command |
| --- | --- |
| Sign in and limit scope to your organization | `node "$PLUGIN_ROOT/bin/signin" --org your-github-org` |
| Inspect sign-in claims and expiry (no raw token) | `node "$PLUGIN_ROOT/bin/sk-jwt"` |
| Show project settings and allowed identities | `node "$PLUGIN_ROOT/bin/sk-telemetry" status` |
| Enable / disable this project | `node "$PLUGIN_ROOT/bin/sk-telemetry" enable` / `disable` |
| Pause / resume all Codex collection and uploads | `node "$PLUGIN_ROOT/bin/sk-telemetry" disable --global` / `enable --global` |
| Sign out | `node "$PLUGIN_ROOT/bin/signout"` |

Sign-in uses your authenticated GitHub CLI when available, otherwise a GitHub
device-login flow. `--org` limits which of your GitHub identities are stored;
it is repeatable. Collection additionally requires consent for a repository
within the licensed organization.

The credential file is shared with SkillMeter for Claude Code. Signing out
removes the shared license, so it affects both clients. Device identity is kept.
Sign-out also retires unsent Codex data. Global pause retains queued data for
later delivery, subject to retention; it does not delete it immediately.

## Collection scope

This draft requires a prior sign-in, an eligible GitHub repository in the licensed
organization, and explicit organization and repository consent. Released 0.5.x
versions still auto-enable eligible repositories unless you opt out.

Enable collection from the repository using the command above. Consent is shared
with Claude in `~/.skillbench/telemetry-policy.json`, across clones and worktrees.
A legacy project-local `skillmeter.telemetry: false` remains a veto until changed
explicitly. An unset consent decision does not enable capture.

Repository OFF retires that repository's queued events and transcripts. Global
OFF pauses capture and delivery while retaining already authorized payloads.
Pre-consent and observed disabled transcript intervals remain excluded on resume
and during baseline recovery. Historical snapshots are not migrated automatically.

## Data and privacy

Collected data can include:

- Prompts, assistant messages, tool inputs and outputs, and session transcripts.
- Session, model and plugin metadata, lifecycle events, and subagent activity.
- Configuration names and counts, plus bounded descriptions and bodies of
  custom project/user skills. This is **not metadata-only collection**.

Known secrets and rule-detectable personal information are redacted before upload
using Claude's policy 3.1.0. Structured file paths retain technical vocabulary,
extensions and hierarchy; other segments are hashed with a per-device salt.
Working directories, generic paths, commands and patches remain whole hashes.
Consented events include the repository name in clear. Names and ordinary
conversation content may remain readable; sanitization does not guarantee that
all personal or confidential information is removed. See the [source and adapter
reference](../../docs/claude-parity.md).

Credentials, device ID and hash salt live in `~/.skillbench/credentials.json`.
Queued telemetry lives under the plugin data directory's `logs/` folder, falling
back to `~/.skillbench/codex` when no host data directory is provided.
SkillMeter sends authenticated data to the tenant endpoint in the license's
`aud` claim. Events go to the event pipeline; transcripts go to object storage
for downstream analysis.

## Uploads and troubleshooting

Uploads use durable local queues. Transcript chunks retain their order and
retry identity across interruption and restart. A send failure does not require
reinstalling the plugin or deleting its data. Consented capture can continue
during token expiry; delivery requires fresh credentials. Unsent data expires
after seven days and is retired on sign-out, authoritative license revocation
or consent withdrawal.

| Symptom | Check |
| --- | --- |
| Reinstall still shows an old version | For a local marketplace, update the source checkout first; for a Git marketplace, run `marketplace upgrade`. |
| Collection is paused or the repository is excluded | Check organization/repository consent, global settings and the licensed organization. |
| Uploads fail with 401/403 | Credentials and queued uploads are retained; background recovery requests a refreshed license. Check sign-in status if failures persist. |
| Transcript delivery needs investigation | Use the [read-only inventory and recovery guide](integration/README.md#queue-and-recovery). |

Token refresh is automatic during active retry-monitor sweeps and at session
start. Delivery waits for a valid token. Silent GitHub reactivation requires a
matching prior sign-in identity and a working GitHub CLI login with access to
organization memberships; if recovery fails, invoke sign-in explicitly.

Current limitations:

- Full compatibility with Claude's latest broker authentication and shared
  credential writes is not complete; see [compatibility](../../docs/claude-parity.md#compatibility).
- Historical transcripts are not automatically replayed.
- Multi-day transcript continuity depends on the collector's missing-baseline
  recovery support. See the [transport guide](integration/README.md).
- Report availability depends on downstream transcript processing; successful
  event uploads alone do not confirm a complete report.

## Bundled skills

| Skill | Purpose |
| --- | --- |
| [signin](skills/signin/SKILL.md) | Authenticate with GitHub and choose organization scope |
| [signout](skills/signout/SKILL.md) | Remove the shared license and stop uploads |
| [check-repo-scope](skills/check-repo-scope/SKILL.md) | Check whether the current repository is eligible |
| [collect-export](skills/collect-export/SKILL.md) | Prepare a sanitized export for a one-off review |
| [review-export](skills/review-export/SKILL.md) | Review an export before upload |

## Development settings

Production routing normally needs no manual configuration. Development overrides:

| Variable | Purpose |
| --- | --- |
| `SKILLMETER_ACTIVATE_URL` | Activation host; also used to derive the refresh URL |
| `SKILLMETER_GITHUB_CLIENT_ID` | GitHub OAuth application for device sign-in |
| `SKILLMETER_BACKEND_URL` | Trusted ingest URL override; uploads still require a valid license |
| `SKILLMETER_HARNESS_HASH_SKILL_NAMES=1` | Hash skill names in harness metadata |

`activate_url` and `github_client_id` also accept values under `skillmeter` in
`.codex/settings.local.json`; environment variables take precedence. There is no
`backendUrl` project setting. `SKILLMETER_STATE_DIR` isolates state for development.

For implementation details, see the [hook definitions](hooks/hooks.json),
[upload code](scripts/logger.js), [sanitizer](scripts/sanitizer.js), and
[transport and recovery guide](integration/README.md). Run `npm run check` from
the repository root when changing plugin code.

# SkillMeter for Codex

SkillMeter sends repository-scoped Codex workflow and conversation telemetry to
[SkillBench](https://skillbench.com). Collection and uploads run in the background.
See the [installation and update guide](../../README.md#install) to get started.

## Sign in and controls

In Codex, ask SkillMeter to sign you in, sign you out, or check whether the
current repository is in scope. The bundled skills are listed below.

For terminal commands, set `PLUGIN_ROOT` to the **Installed plugin root** printed
by `codex plugin add`. For a default 0.6.1 installation:

```sh
export PLUGIN_ROOT="$HOME/.codex/plugins/cache/skillbench/skillmeter/0.6.1"
```

Run project controls from the repository you want to configure:

| Task | Command |
| --- | --- |
| Sign in and limit scope to your organization | `node "$PLUGIN_ROOT/bin/signin" --org your-github-org` |
| Inspect sign-in claims and expiry (no raw token) | `node "$PLUGIN_ROOT/bin/sk-jwt"` |
| Check capture policy, authentication and local queues | `node "$PLUGIN_ROOT/bin/sk-telemetry" status` |
| Enable / disable this project | `node "$PLUGIN_ROOT/bin/sk-telemetry" enable` / `disable` |
| Pause / resume all Codex collection and uploads | `node "$PLUGIN_ROOT/bin/sk-telemetry" disable --global` / `enable --global` |
| Sign out | `node "$PLUGIN_ROOT/bin/signout"` |

Sign-in uses your authenticated GitHub CLI when available, otherwise a GitHub
device-login flow. `--org` limits which of your GitHub identities are stored;
it is repeatable. Without narrowing, your login and organization memberships
are eligible for collection.

The credential file is shared with SkillMeter for Claude Code. Signing out
removes the shared license, so it affects both clients. Device identity is kept.
Global pause retains queued data for later delivery; it does not delete it.

`status` is read-only. It separates repository capture eligibility from license
freshness and reports pending event batches and current-format transcript chunks
across repositories. Expired credentials can pause delivery while eligible local
capture continues. It does not verify hook execution or server acceptance, and
this version does not track the last successful upload. An empty queue does not
prove delivery or report generation; legacy snapshots are excluded from the count.

## Collection scope

A valid sign-in, a recognized GitHub repository, and an allowed remote owner
are required. In 0.6.x:

- Eligible repositories auto-enable when no project choice has been made.
- An explicit project opt-out stops collection even for an allowed owner.
- Enabling a project cannot bring an out-of-scope repository into scope.
- The global pause overrides project choices. There is no OS consent pop-up.

Project choices live in `<project>/.codex/settings.local.json`. To opt out:

```json
{ "skillmeter": { "telemetry": false } }
```

For additional narrowing, set `SKILLMETER_REPO_SCOPE_ORGS` to comma-separated
owners, or use `skillmeter.repoScopeOrgs` in the same settings file. These filters
can only restrict the allowed identities. The status command shows the effective
capture policy; an unset choice can still auto-enable for an allowed owner.

## Data and privacy

Collected data can include:

- Prompts, assistant messages, tool inputs and outputs, and session transcripts.
- Session, model and plugin metadata, lifecycle events, and subagent activity.
- Configuration names and counts, plus bounded descriptions and bodies of
  custom project/user skills. This is **not metadata-only collection**.

Policy 3.1.0 redacts recognized secrets, email addresses, VCS author names,
phone numbers, IP addresses, national identifiers and payment-card numbers with
typed placeholders. File-path fields retain hierarchy, extensions and approved
technical vocabulary; other segments are hashed. Directory fields, commands and
patches are hashed whole with a per-device salt. Free text hashes the home prefix.

Names, addresses and confidential free text may remain readable. Stage-2
sanitization is separate; this plugin does not guarantee complete PII removal.
See the [shared policy and Codex adapter](../../docs/sanitizer-parity.md).

Credentials, device ID and hash salt live in `~/.skillbench/credentials.json`.
Queued telemetry lives under the plugin data directory's `logs/` folder.
SkillMeter sends authenticated data to the tenant endpoint in the license's
`aud` claim. Events go to the event pipeline; transcripts go to object storage
for downstream analysis.

## Uploads and troubleshooting

Uploads use durable local queues. Transcript chunks retain their order and
retry identity across interruption and restart. A send failure does not require
reinstalling the plugin or deleting its data.

| Symptom | Check |
| --- | --- |
| Reinstall still shows an old version | For a local marketplace, update the source checkout first; for a Git marketplace, run `marketplace upgrade`. |
| Collection is paused or the repository is excluded | Check project/global settings and the signed-in GitHub identities. |
| Uploads fail with 401/403 | Credentials and queued uploads are retained; background recovery requests a refreshed license. Check sign-in status if failures persist. |
| Transcript delivery needs investigation | Use the [read-only inventory and recovery guide](integration/README.md#queue-and-recovery). |

Token refresh is automatic during active retry-monitor sweeps and at session
start. Delivery waits for a valid token. Silent GitHub reactivation requires a
working GitHub CLI login with access to organization memberships; if recovery
fails, invoke sign-in explicitly.

Current limitations:

- Full compatibility with Claude's latest broker authentication is not complete.
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
`backendUrl` project setting.

For implementation details, see the [hook definitions](hooks/hooks.json),
[upload code](scripts/logger.js), [sanitizer](scripts/sanitizer.js), and
[transport and recovery guide](integration/README.md). Run `npm run check` from
the repository root when changing plugin code.

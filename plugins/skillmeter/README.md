# SkillMeter for Codex

SkillMeter sends repository-scoped Codex workflow and conversation telemetry to
[SkillBench](https://skillbench.com). Collection and uploads run in the background.
See the [installation and update guide](../../README.md#install) to get started.

## Sign in and controls

In Codex, ask SkillMeter to sign you in, sign you out, show collection status,
enable or disable the repository you are in, or check whether it is in scope.
The bundled skills are listed below.

For terminal commands, set `PLUGIN_ROOT` to the **Installed plugin root** printed
by `codex plugin add`. Replace the placeholder below with that exact path so the
commands use the installed version rather than an older cached copy:

```sh
export PLUGIN_ROOT="/absolute/path/to/installed/skillmeter"
```

Run project controls from the repository you want to configure:

| Task | Command |
| --- | --- |
| Sign in and limit scope to your organization | `node "$PLUGIN_ROOT/bin/signin" --org your-github-org` |
| Inspect sign-in claims and expiry (no raw token) | `node "$PLUGIN_ROOT/bin/sk-jwt"` |
| Check capture policy, authentication and local queues | `node "$PLUGIN_ROOT/bin/sk-telemetry" status` |
| Preview local/shared consent conflicts | `node "$PLUGIN_ROOT/bin/sk-telemetry" consent-preview` |
| Enable / disable this project | `node "$PLUGIN_ROOT/bin/sk-telemetry" enable` / `disable` |
| Pause / resume all Codex collection and uploads | `node "$PLUGIN_ROOT/bin/sk-telemetry" disable --global` / `enable --global` |
| Sign out | `node "$PLUGIN_ROOT/bin/signout"` |

Sign-in uses your authenticated GitHub CLI when available, otherwise a GitHub
device-login flow. `--org` limits which of your GitHub identities are stored;
it is repeatable. Without narrowing, your login and organization memberships
are eligible for collection.

The credential file is shared with SkillMeter for Claude Code. Signing out
removes the shared license, so it affects both clients. Device identity is kept.
Global pause retains queued data for later delivery, but sealed event batches
are still removed 30 days after sealing, paused or not.

`status` is read-only. It separates repository capture eligibility from license
freshness and reports pending event batches and current-format transcript chunks
across repositories. Expired credentials can pause delivery while eligible local
capture continues. It does not verify hook execution or server acceptance, and
this version does not track the last successful upload. An empty queue does not
prove delivery or report generation; legacy snapshots are excluded from the count.

`consent-preview` shows choices at the repository root and along the path to the
current directory, shared opt-outs and missing machine-wide acknowledgements.
Use `--json` for structured output. It does not scan other directories or change
consent settings, credentials or queued data. It records a local observation
marker so a later missing shared policy is reported.

To record an explicit shared repository choice, use the repository key and
revision shown by a fresh preview:

```sh
node "$PLUGIN_ROOT/bin/sk-telemetry" consent-set on \
  --repository github.com/org/repo --revision 12 --acknowledge-machine-scope
node "$PLUGIN_ROOT/bin/sk-telemetry" consent-set off \
  --repository github.com/org/repo --revision 13
```

ON authorizes every supported SkillMeter client and every clone or worktree of
that repository on this machine. It requires machine-wide organization consent
already recorded at version 2; this command cannot authorize an organization or
upgrade its legacy choice. Local OFF or invalid settings must be resolved
explicitly first. OFF needs no acknowledgement. For an absent policy, use
`--revision absent`; only OFF can proceed without organization authorization.
A stale revision or changed repository requires a new preview and confirmation.

Local settings are preserved, including restrictions in other directories.
This version still requires local opt-in for Codex capture. The command checks
known local queue revocations without uploading, reports deferred cleanup, and
preserves privacy cursors. In-flight requests may finish. A saved choice does
not prove hook execution, delivery or report generation.

## Collection scope

ChatGPT Work transcript delivery is not supported. A transcript containing
`session_meta.originator=codex_work_desktop` is rejected during staging even in
an eligible repository. This does not purge previously queued data or change
hook-event collection. Per-task Work consent and delivery remain separate work.

A recognized GitHub repository and an allowed remote owner are required:

- Eligible repositories remain off until explicitly enabled.
- An explicit project opt-out stops collection even for an allowed owner.
- Enabling a project cannot bring an out-of-scope repository into scope.
- The global pause overrides project choices. There is no OS consent pop-up.

Project controls read and write `<git-root>/.codex/settings.local.json`, including
when run from a subdirectory. Existing root choices remain effective. Missing,
malformed or non-boolean choices stay off. To opt in:

```json
{ "skillmeter": { "telemetry": true } }
```

For additional narrowing, set `SKILLMETER_REPO_SCOPE_ORGS` to comma-separated
owners, or use `skillmeter.repoScopeOrgs` in the same settings file. These filters
can only restrict the allowed identities. An unset choice does not authorize
capture. Nested repositories require their own choice. Legacy subdirectory
opt-outs remain restrictive; subdirectory opt-ins cannot enable the whole repo.

This follows Claude's explicit repository opt-in rule. Codex still stores the
choice per checkout, so clones and linked worktrees require separate choices.
It does not yet use Claude's shared organization/repository policy store.
Repository disable stops new capture and removes that repository's queued,
unsent event and transcript payloads; privacy cursors are kept, so re-enabling
does not restore removed data, and requests already in flight complete. Global
pause stops capture and transmission while retaining queues. Observed disabled
transcript intervals are excluded from later staging and baseline recovery. The
first observation excludes existing content, so native startup timing matters
for capture completeness. Shared policy remains required for full consent
parity. See the [alignment boundary](../../docs/repository-consent.md).

## Data and privacy

Collected data can include:

- Prompts, assistant messages, tool inputs and outputs, and session transcripts.
- Session, model and plugin metadata, lifecycle events, and subagent activity.
- Configuration names and counts, plus bounded descriptions and bodies of
  custom project/user skills. This is **not metadata-only collection**.

Policy 3.1.1 redacts recognized secrets, email addresses, VCS author names,
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
reinstalling the plugin or deleting its data. Each later wire chunk, including
chunks split from a large batch, opens with a `session_continuation` record that
carries only the session id, working directory, originator and lineage, so a
stored object that holds later chunks of a long session can still be attributed
to that session. This requires a usable first `session_meta` record and metadata
preservation; otherwise, later batches remain content-only.

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
| [telemetry](skills/telemetry/SKILL.md) | Show collection status; enable, disable, pause or resume collection |
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

Tests live under `test/` by purpose (`sanitizer`, `consent`, `hooks`,
`transport`, `auth`) with shared fixtures in `test-support/`. Queue revocation
runs with `node --test plugins/skillmeter/test/consent/queue-revocation.test.js`
from the repository root; it uses synthetic repositories and an intercepted
fetch to check repository payload purge, mixed-batch isolation and retry
authorization against Claude's `scripts/lib/repository-queue.js` contract.

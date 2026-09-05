# SkillMeter


SkillMeter is the SkillBench **live telemetry plugin for Codex**. It records
privacy-scoped lifecycle telemetry from your Codex sessions and forwards it to the
SkillBench analyzer so your weekly skill reports include Codex activity
alongside Claude Code and GitHub PR data.


It is the Codex counterpart to the SkillMeter Claude Code plugin: same NDJSON
envelope, same collector, same privacy model. Codex events are tagged
`agent: "codex"` so they land in the shared pipeline but stay queryable on their
own.


## What it does


The plugin wires a handler into every Codex lifecycle hook that exists today:


| Hook | When it runs | Recorded payload |
|------|--------------|------------------|
| `SessionStart` | A Codex session starts (`startup`, `resume`, `clear`, `compact`) | `source`, `model`, `permission_mode`, [`harness`](#harness-metadata) |
| `UserPromptSubmit` | The user submits a prompt | sanitized `prompt`, `permission_mode` |
| `PreToolUse` | Before `Bash`, `apply_patch`, or an MCP tool runs | `tool_name`, sanitized `tool_input`, `tool_use_id` |
| `PermissionRequest` | Codex is about to ask for approval | `tool_name`, sanitized `tool_input`, sanitized approval `description` |
| `PostToolUse` | After a supported tool runs (success or failure) | `tool_name`, sanitized `tool_input`, sanitized `tool_response`, `tool_use_id` |
| `PreCompact` | Before context compaction | `trigger` (`manual` or `auto`) |
| `PostCompact` | After context compaction | `trigger` |
| `SubagentStart` | A subagent thread starts | `agent_id`, `agent_type` |
| `SubagentStop` | A subagent thread stops | `agent_id`, `agent_type`, `agent_transcript_path`, `stop_hook_active`, sanitized `last_assistant_message` |
| `Stop` | A turn stops | `stop_hook_active`, sanitized `last_assistant_message` |
| `SessionEnd` | The main session ends | `reason`; bounded capture hint |
| `Interrupt` | An active main-thread turn is interrupted | `turn_id`; bounded capture hint |


Every event record also carries `session_id`, `device_id`, `agent: "codex"`,
the current `model` and `turn_id`, hashed `cwd`/`repo_root`, and the
`repo_scope` decision for the current project.

These twelve events match the [official hook catalog](https://learn.chatgpt.com/docs/hooks)
verified on 2026-09-05. `SessionEnd` and `Interrupt` have a three-second maximum.
Their handlers save small capture hints and detach the upload work. Actual CLI
and desktop install/canary validation remains required before release.


## Harness metadata

To judge a session fairly, analysis needs to know whether the developer was
working *bare* or with a sophisticated **harness** — the instruction files,
skills, hooks, plugins, and orchestration wrapped around the agent. The
`SessionStart` event carries a `harness` block describing the **presence and
shape** of that scaffolding. It is **metadata only**: SkillMeter never collects
raw `AGENTS.md` / `CLAUDE.md` / skill / hook-config contents (that is a separate,
higher-risk phase that would route through the Tier 2 sanitization policy).

Detection is split by what is actually observable:

- **Level 1 (filesystem-detectable, collected today):** instruction-file
  presence, skills, hooks, and plugin/agent info — probed once at session start
  by [`scripts/harness.js`](scripts/harness.js).
- **Level 2 (architecture-level, NOT detectable):** external orchestration and
  multi-agent setups. These can't be inferred from the filesystem or transcript,
  so they are reported as the explicit string `"unknown"` rather than a
  misleading `false`. (`subagent_used` is derived downstream from the
  `SubagentStart` / `SubagentStop` events the collector already emits.)

Example `harness` payload:

```json
{
  "schema_version": 2,
  "policy_version": "1.0.0",
  "agent_type": "codex",
  "plugin": { "name": "skillmeter", "version": "0.2.0+codex…" },
  "instructions": {
    "has_agents_md": true,
    "has_agents_md_global": false,
    "has_claude_md": false,
    "has_claude_md_global": false,
    "scopes": ["project"]
  },
  "skills": { "count": 3, "names": ["deploy", "review-pr", "signin"], "scopes": ["project", "global"] },
  "hooks": { "enabled": ["PostToolUse", "PreToolUse", "SessionStart", "Stop"], "scopes": ["plugin"] },
  "orchestration": { "external_orchestration": "unknown", "multi_agent": "unknown" },
  "redactions": { "hashed_count": 0, "dropped_count": 0, "by_type": {} }
}
```

What is probed:

| Field | Source |
|-------|--------|
| `instructions.has_agents_md` / `has_claude_md` | `AGENTS.md` / `CLAUDE.md` in the cwd or repo root |
| `instructions.has_*_global` | `~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md` |
| `skills.count` / `names` / `scopes` | `SKILL.md` files under `.codex/skills/` (project and `~/.codex/skills/`); hidden `.system` namespaces (runtime built-ins) are skipped |
| `hooks.enabled` / `scopes` | allow-listed lifecycle event names declared in the plugin's `hooks.json` and any project/global `.codex/hooks.json` |
| `plugin` / `agent_type` / `schema_version` | this plugin's manifest and the harness schema version |
| `policy_version` | the sanitization policy version this metadata was produced under |
| `redactions` | sanitization bookkeeping (`hashed_count`, `dropped_count`, `by_type`) — counts/types only |

Privacy notes:

- The whole `harness` block is routed through the same central
  `sanitizeEventData` boundary as every other event field, so a skill or hook
  name that happens to embed a secret/email is still scrubbed before upload.
- **Tier 1 fail-closed at the harness boundary (Phase 2, SBEE-165):** before any
  skill name is hashed or emitted it is scanned for Tier 1 secrets, and a name
  that embeds one is **dropped** outright (the hashing step would otherwise hide
  it from the downstream scrubber). Every hash and drop is tallied in the
  `redactions` block — `hashed_count`, `dropped_count`, and a `by_type`
  breakdown — which records counts and field types only, never the original
  values. `skills.count` always keeps the true on-disk total.
- The block also carries `policy_version`, sourced from the same constant the
  central sanitizer uses, so the harness metadata and the event's sanitization
  summary always agree on which 3-tier policy applied.
- Only **allow-listed** hook event names are reported, so an arbitrary
  user-authored `hooks.json` can't inject free-form strings into the metadata.
- Skill names are emitted in plaintext by default (they're typically generic and
  useful for cross-session comparison). Set
  `SKILLMETER_HARNESS_HASH_SKILL_NAMES=1` to emit HMAC-hashed `names_hashed`
  instead when skill names may be sensitive.
- Detection is filesystem-only, depth-bounded, and fail-safe: any error leaves
  the safe `unknown`/empty defaults in place and never breaks the session.


## Data flow


```text
Codex lifecycle event
  -> ${PLUGIN_ROOT}/scripts/<event>.js
  -> append NDJSON entry to ${PLUGIN_DATA}/logs/events.jsonl
  -> lifecycle capture hint + Stop / SubagentStop / SessionEnd event sealing
  -> detached drain (drain_once.js): sanitize complete raw lines, commit immutable
     chunks + cursor, then gzip + POST
     to the resolved backend (default https://api.meter.skillbench.ai/logs/codex)
  -> SkillBench Codex collector lambda
  -> OTel Collector
  -> ClickHouse skillmeter.otel_logs
  -> skillbench-pipelines AI-usage analyzer -> existing report store/dashboard
```


In ClickHouse, Codex events are attributed to their own
`ServiceName = skillmeter-codex-collector-<tenant>-<env>` (the collector derives
the service name from the event's `agent`), so Codex is queryable separately
from Claude Code while sharing the same `otel_logs` table.


### Durable uploads, background flush, and retry

Lifecycle hooks persist small capture hints under `logs/transcripts/captures-v1/`.
The detached drain stages sanitized immutable gzip chunks in
`logs/transcripts/chunks-v1/{source-key}/batch-*/`. Each transaction has a manifest,
chunk hashes, and a ready marker. The cursor is persisted only after every chunk
is durable; restart recovery finishes published transactions before sending.

The Codex cursor records complete raw byte position, prefix HMAC, file identity,
sequence and reset generation. Partial final lines remain eligible on the next
capture. Rewrites and replacements start a higher reset baseline; every later
chunk carries that baseline so delayed old-generation appends cannot reappear.
Records receive a transport UUID derived from raw position/content before
sanitization, preserving separate records that redact to the same content.

A per-source PID lock serializes staging and draining, including concurrent hook
processes. Live locks are never stolen by age. Retries retain the exact gzip body,
sequence and reset header. Only acknowledged chunks are removed. Chunk splitting
uses actual gzip/base64 size plus a 128 KiB envelope reserve, capped at 5 MiB;
individual decoded records must stay below the collector's 32 MiB default.
Oversized or malformed complete records preserve the cursor/source and save a
content-free diagnostic. Deployment-specific gateway limits still need verification.

Capture and each upload recheck signout, global disable, current user/device,
allowed orgs and project consent. Source `session_meta`/`turn_context` cwd values
must remain in the authorized repository. Queues cannot move between principals.
A rejected/expired token retains the queue; transcript upload does not clear shared
credentials or retry anonymously. Existing event-log handling is unchanged.

`SessionStart` still recovers/seals orphaned event logs and starts the bounded
retry monitor. Event `.sent`/poison files retain their existing cleanup policy.
Legacy transcript pending/poison files are preserved and excluded from automatic
upload and expiry. New transcript chunks are also retained on failure.

For a content-free, read-only recovery inventory:

```bash
PLUGIN_DATA=/path/to/plugin-data node scripts/transcript_inventory.js
```

This reports counts and known diagnostics; old quarantine reasons may be unknown
because the former client did not persist them. It never replays anything.
Recovery must select still-authorized source files and pass them through the
current sanitizer and scope gates. Do not bulk-replay historical queues.

Rollback: the old client cannot read `chunks-v1`. Pause telemetry first and retain
the entire plugin data directory; drain with the repaired client after validation,
or keep the data for explicit recovery. Do not relabel chunks as legacy snapshots
or run an older cleanup routine against retained transcript queues.

The source repair is not release validation. Multi-day storage continuity,
recorded/live analyzer execution and correct-user dashboard evidence remain
required. No release artifact or deployment is produced by these changes.


## Install


```bash
codex plugin marketplace add SkillBench-AI/skillmeter-codex-marketplace
```


Then open Codex, run `/plugins`, install `SkillMeter`, and start a fresh
thread. Codex will list the plugin's hooks in `/hooks` for review. Plugin
hooks are skipped until you trust them.


For local testing:


```bash
codex plugin marketplace add ./skillmeter-codex-marketplace
```


## Configuration


| Variable | Default | Purpose |
|----------|---------|---------|
| `SKILLMETER_BACKEND_URL` | unset | Per-session ingest-endpoint override (highest priority) |
| `SKILLMETER_ACTIVATE_URL` | `https://api.skillbench.ai/activate` | License activation endpoint (`/refresh` is derived from the same host). Point at `https://api.dev.skillbench.com/activate` to run against dev. |
| `SKILLMETER_GITHUB_CLIENT_ID` | prod OAuth App | GitHub OAuth App client id used by the device-login flow |
| `SKILLMETER_TIMEOUT` | `10` | Event-batch upload timeout (seconds) |
| `SKILLMETER_MAX_BATCH_RETRIES` | `25` | Transient-failure attempts before a sealed batch is quarantined as poison |
| `SKILLMETER_BATCH_MAX_AGE_MS` | `1209600000` | Max age (14 days) an undeliverable batch/transcript is retried before being quarantined |
| `SKILLMETER_ACTIVE_LOG_STALE_MS` | `300000` | Idle age after which an un-rotated `events.jsonl` is treated as crash debris and recovered |
| `SKILLMETER_RETRY_DAEMON_INTERVAL_MS` | `120000` | Retry-monitor sweep interval |
| `SKILLMETER_RETRY_DAEMON_INITIAL_DELAY_MS` | `60000` | Retry-monitor delay before its first sweep (avoids racing the SessionStart drain) |
| `SKILLMETER_RETRY_DAEMON_MAX_IDLE_SWEEPS` | `15` | Empty sweeps before the retry monitor self-terminates |
| `SKILLMETER_RETRY_DAEMON_MAX_LIFETIME_MS` | `28800000` | Hard cap on retry-monitor lifetime |


The ingest endpoint is resolved at upload time in this order (mirroring the
Claude plugin — you pick the environment on the activation side via
`activate_url`, and the upload host is read back out of the license JWT rather
than configured separately):

1. `SKILLMETER_BACKEND_URL` env var — a dev/test bypass that skips the JWT
   entirely (point it at a fake server without minting a token)
2. The `telemetry_endpoint` claim of the license JWT (per-tenant routing — see
   [Identity & authentication](#identity--authentication)), with the
   `/logs/codex` route appended. The claim is read even from an expired token so
   a drain still reaches the right tenant host while a refresh is pending.
3. built-in default (prod): `https://api.meter.skillbench.ai/logs/codex`

Step 1 is user-supplied, so it's validated against a trusted-domain allow-list.
Step 2 is server-minted at sign-in and trusted as-is.

There is no `backendUrl` settings key. To run against a non-default
environment, point activation at that environment (`activate_url` /
`SKILLMETER_ACTIVATE_URL`); the JWT minted there carries the matching
`telemetry_endpoint`, so uploads route to the same environment automatically.
See [Pointing at a non-default environment](#pointing-at-a-non-default-environment).


Per-project opt-in lives in `<project>/.codex/settings.local.json`:


```json
{
  "skillmeter": {
    "telemetry": true,
    "activate_url": "https://api.dev.skillbench.com/activate"
  }
}
```

Repo scope is **not** configured here — it derives from the GitHub identities of
the signed-in user (see [Repo-scoped filtering](#repo-scoped-filtering)).

### Pointing at a non-default environment

`SKILLMETER_ACTIVATE_URL` and `SKILLMETER_GITHUB_CLIENT_ID` both also accept
persistent per-project values via `.codex/settings.local.json`:

```json
{
  "skillmeter": {
    "activate_url": "https://api.dev.skillbench.com/activate",
    "github_client_id": "<dev OAuth App client_id>"
  }
}
```

Resolution order is env var → settings file → built-in default. Set these
together when activating against dev; once the license JWT is cached, telemetry
routing is read straight from its `telemetry_endpoint` claim, so uploads follow
the same environment without a separate `backendUrl`. (`SKILLMETER_BACKEND_URL`
remains available only as a local-dev bypass that points uploads at a fake
server without a token.)


You can toggle telemetry per-project with the bundled CLI:


```bash
node "$PLUGIN_ROOT/scripts/telemetry.js" enable
node "$PLUGIN_ROOT/scripts/telemetry.js" status
node "$PLUGIN_ROOT/scripts/telemetry.js" disable
```

You can also pause or resume all Codex telemetry uploads on the machine,
regardless of project opt-in, with the global switch:

```bash
node "$PLUGIN_ROOT/scripts/telemetry.js" disable --global
node "$PLUGIN_ROOT/scripts/telemetry.js" enable --global
```

While globally disabled, hooks do not record new events and durable queues are
left on disk instead of being uploaded.

Consent is collected **in-context — there is no OS pop-up**. When a project has
no explicit opt-in, telemetry **auto-enables only if the repo is owned by one of
your allowed GitHub orgs** (owned-org auto-enable, matching the Claude Code
plugin); a passive `(telemetry auto-enabled — repo owned by allowed org)` notice
prints and you can opt out any time with `telemetry.js disable`. For any other
project the first `SessionStart` prints the enable/disable/status commands and
leaves it "not configured" until you choose. This works identically on
headless/SSH/CI sessions — nothing is ever gated behind a desktop dialog.


## Identity & authentication

SkillMeter authenticates uploads and resolves the per-tenant ingest endpoint
from a license JWT, matching the Claude Code plugin. The license, allowed-org
list, device id, and hash salt are shared via `~/.skillbench/credentials.json`,
so signing in through either plugin authenticates both.

### Sign in

```bash
node "$PLUGIN_ROOT/scripts/signin.js"
```

(or invoke the bundled `signin` skill). The flow:

1. **Silent `gh` activation.** If the GitHub CLI is already authenticated,
   `gh auth token` is exchanged at the activation endpoint for a license JWT —
   no prompts.
2. **GitHub device flow.** Otherwise a device-login code + verification URL are
   printed. After you approve on GitHub, the code is exchanged for a license
   JWT and your GitHub orgs are recorded. In a real TTY the script polls inline;
   in a buffered runner it polls in the background and you re-run sign-in to
   confirm.

Once a license is stored, every event/transcript upload is sent with an
`Authorization: Bearer <jwt>` header and routed to the tenant host from the
JWT's `telemetry_endpoint` claim.

### Sign out

```bash
node "$PLUGIN_ROOT/scripts/signout.js"
```

(or the `signout` skill). This drops the license JWT and org list, sets a
`signed_out` sentinel so a still-authenticated `gh` CLI doesn't silently
re-mint a license on the next session, and enables the machine-global telemetry
kill-switch. The `device_id` and `hash_salt` are preserved, so signing back in
reuses the same machine identity and clears the global switch.

### Command-line tools (`bin/`)

For quick auth/debug work from a shell — without an LLM round-trip through a
skill — the plugin ships thin CLI wrappers in `bin/` (parity with the Claude
Code plugin):

| Tool | Purpose |
|------|---------|
| `bin/signin` | Run the sign-in flow (silent `gh` / GitHub device flow) |
| `bin/signout` | Sign out, drop the license, and pause uploads |
| `bin/sk-jwt` | Print the stored license JWT's claims (org, endpoint, expiry) in human-readable form — **never** prints the raw token |
| `bin/sk-refresh` | Clear the stored license and re-activate immediately (swap tenants / recover from a revoked token / test the silent-gh path) |
| `bin/sk-telemetry` | `enable` / `disable` / `status` telemetry, with `--global` for the machine-wide kill switch (forwards to `scripts/telemetry.js`) |

```bash
node "$PLUGIN_ROOT/bin/sk-jwt"            # inspect the current license
node "$PLUGIN_ROOT/bin/sk-refresh"        # force a fresh activation
node "$PLUGIN_ROOT/bin/sk-telemetry" status
```

### JWT refresh & token-clear-and-retry

- **Proactive refresh.** `SessionStart` rotates a missing or near-expiry JWT via
  the activation Lambda's `/refresh` endpoint (no GitHub round-trip), falling
  back to the silent `gh` path on `410`/`404`/network errors. The long-running
  retry monitor repeats the same rotation on its ~120s sweep, so a session that
  outlives its token stays inside the `/refresh` sliding window without a
  re-sign-in. Best-effort and non-blocking.
- **Silent re-mint after the window lapses.** `/refresh` enforces a sliding
  window against the token's `original_iat`; once it closes, `/refresh` returns
  `410` and a full re-activation is required. The silent `gh` fallback covers
  this **only if the local `gh` CLI token carries the `read:org` scope** — it
  fetches your org memberships during activation, so a token without that scope
  fails the silent path and drops to the interactive device flow. See
  [Testing](#testing) for how to arm this for unattended runs.
- **Expiry guard.** A JWT past its `exp` is dropped before a request is sent
  rather than sent and rejected.
- **401/403 handling.** If the backend rejects the `Authorization` header, the
  stored license is cleared and the upload is retried once unauthenticated, so a
  revoked/rotated token can't permanently wedge the durable queue.

## Privacy


- **Device ID, hash salt, license JWT, and allowed-org list** are stored in
  `~/.skillbench/credentials.json` (mode `0600`, written atomically) and shared
  with the SkillMeter Claude Code plugin so the SkillBench analyzer sees one
  device per machine and one sign-in across agents.
- **Paths** (`cwd`, `repo_root`, `tool_input.file_path`, `command`, `patch`)
  are HMAC-SHA256 hashed with the per-machine salt before they leave the
  session.
- **Raw content is scrubbed before upload.** Every event — the submitted
  `prompt`, `last_assistant_message`, approval `description`, tool arguments,
  tool output, and the staged session transcript — passes through a single
  deterministic sanitization boundary (`scripts/sanitizer.js`) before it is
  written to the durable queue or uploaded. The boundary is fail-closed for
  Tier 1 secrets: API keys, GitHub/Slack tokens, JWTs, AWS access keys, PEM/SSH
  private keys, `Authorization` headers, database URLs with credentials, and
  `*_KEY=`/`*_TOKEN=`/`PASSWORD=`/`SECRET=` style assignments are replaced with
  `[REDACTED_SECRET]`, and emails are replaced with `[EMAIL]`. Only the count
  and detector types of any redactions travel with the event (under
  `_sanitization`); the original sensitive values are never stored or logged.
  This is deterministic, not LLM-based, and runs centrally in `runHook` so a new
  hook field cannot bypass it. It is a best-effort secret/PII filter, not a
  guarantee of complete PII removal — see `SANITIZATION_EPIC.md` for the full
  tiered model.
- **Repo scope filtering** stops uploads from repos outside the GitHub orgs the
  signed-in user belongs to (see below). The default posture is closed: with no
  signed-in orgs, every event is dropped at the hook rather than uploaded.
- **Trust review.** Codex skips plugin-bundled hooks until you review and
  trust the current hook definition via `/hooks`. Changing this plugin's hooks
  invalidates the trust and requires re-review.

### Repo-scoped filtering

Telemetry is gated to repositories owned by GitHub identities the signed-in user
controls — their own login plus every org returned by `GET /user/orgs`. The list
is captured at signin (using the same OAuth token that exchanges for the
SkillMeter license) and stored in `~/.skillbench/credentials.json` next to the
device ID and license JWT.

Events are dropped — even in projects where you ran `telemetry.js enable` — for:

- a machine that is not signed in (no allowed orgs cached → `not_activated`)
- directories that are not inside a Git repository
- repositories without a recognizable GitHub remote
- repositories whose remote belongs to an org the user is not a member of

To refresh the allowed identity list (e.g. after joining a new org), run the
`signin` skill again.

#### Narrowing scope to specific orgs

By default every signed-in org is in scope. If your account belongs to several
orgs but you only want to capture telemetry for some of them (for example, only
`skillbench-ai`), narrow it. Narrowing is intersected with your signed-in orgs,
so it can only restrict the captured set — never widen it (a repo in an org you
are not a member of stays blocked).

**At sign-in (recommended)** — scope which orgs are even persisted. Useful when
the silent `gh` path would otherwise enroll every org your account belongs to:

```bash
node "$PLUGIN_ROOT/scripts/signin.js" --org skillbench-ai
```

`--org` is repeatable and accepts comma-separated values. If you are already
signed in, re-running with `--org` re-scopes the stored org list in place
(no full re-auth needed). Re-expanding later requires sign-out + sign-in.

**At runtime** — narrow the repo-scope gate without touching the stored org
list. Resolution order (env var wins, mirroring the backend-URL resolver):

1. `SKILLMETER_REPO_SCOPE_ORGS` — comma- or space-separated env var, applied to
   every project on the machine. Useful for a single-org workstation:

   ```bash
   export SKILLMETER_REPO_SCOPE_ORGS="skillbench-ai"
   ```

2. `skillmeter.repoScopeOrgs` in `<project>/.codex/settings.local.json` — an
   array (or comma-separated string), scoped to that project:

   ```json
   { "skillmeter": { "repoScopeOrgs": ["skillbench-ai"] } }
   ```

Org names are matched case-insensitively. Leaving everything unset preserves the
default "all signed-in orgs" behavior. The same `SKILLMETER_REPO_SCOPE_ORGS` /
`skillmeter.repoScopeOrgs` values are also honored at sign-in (precedence:
`--org` > env > setting), so a configured scope narrows the persisted org list
even on the silent `gh` path.


## Bundled skills


The plugin ships these skills under `skills/`:


- `signin` — sign in to SkillMeter with GitHub (silent `gh` or device flow)
- `signout` — sign out and stop authenticating uploads
- `collect-export` — produce a sanitized session-collector export
- `check-repo-scope` — verify whether the current repo is in scope
- `review-export` — summarize a sanitized export before upload


The lifecycle hooks are the primary, always-on telemetry path; these skills
remain useful for one-off batch exports and audits on top of the live feed.


## Repo layout


```text
skillmeter-codex-marketplace/
├── .agents/plugins/marketplace.json
├── .claude-plugin/marketplace.json
└── plugins/skillmeter/
    ├── .codex-plugin/plugin.json
    ├── README.md
    ├── hooks/hooks.json
    ├── bin/                   # shell-facing auth/debug CLIs (thin wrappers)
    │   ├── signin
    │   ├── signout
    │   ├── sk-jwt            # print license JWT claims (no raw token)
    │   ├── sk-refresh        # clear license + re-activate
    │   └── sk-telemetry      # enable/disable/status telemetry
    ├── scripts/
    │   ├── logger.js          # logging + durable queue/drain/retry transport + auth wiring
    │   ├── credstore.js       # shared ~/.skillbench/credentials.json (identity + license)
    │   ├── signin.js          # GitHub device-flow / silent-gh sign-in
    │   ├── signout.js         # drop license + block silent re-signin
    │   ├── lib/
    │   │   ├── jwt.js               # JWT decode/expiry + telemetry_endpoint resolution
    │   │   ├── license-activation.js # /activate, /refresh, silent gh activation
    │   │   ├── github-api.js        # GitHub /user + /user/orgs lookup
    │   │   ├── settings.js          # per-project string settings (activate_url, client id)
    │   │   ├── banner.js            # sign-in welcome banner
    │   │   └── spinner.js           # TTY spinner for the device-flow poll
    │   ├── sanitizer.js       # pre-upload Tier 1 secret / Tier 2 PII redaction + transcript scrubbing
    │   ├── harness.js         # Level 1 harness detection (instruction files, skills, hooks, plugin/agent metadata)
    │   ├── telemetry.js
    │   ├── drain_once.js      # detached one-shot queue drain
    │   ├── monitors/
    │   │   └── retry_daemon.js  # long-running singleton retry monitor
    │   ├── session_start.js
    │   ├── user_prompt_submit.js
    │   ├── pre_tool_use.js
    │   ├── permission_request.js
    │   ├── post_tool_use.js
    │   ├── pre_compact.js
    │   ├── post_compact.js
    │   ├── subagent_start.js
    │   ├── subagent_stop.js
    │   └── stop.js
    ├── test/
    │   ├── auth.test.js       # unit tests for JWT routing, credstore, 401/403 retry
    │   ├── repo-scope.test.js # unit tests for default privacy posture / repo-scope gating
    │   ├── durability.test.js # unit tests for poison-batch handling, salvage, retry/age limits, atomic writes
    │   ├── sanitization.test.js # unit + e2e tests for pre-upload secret/PII redaction
    │   ├── sanitizer-edge-cases.test.js # boundary/idempotency/metadata edge cases for the sanitizer
    │   ├── logger.test.js     # unit tests for sanitizeToolData (path hashing) + getBackendUrl resolution
    │   ├── hook-surface.test.js # guards the verified 10-event Codex hook catalog in hooks.json
    │   ├── bin-cli.test.js    # unit tests for the bin/ auth/debug CLIs
    │   ├── telemetry-consent.test.js # unit tests for cross-platform consent prompts
    │   └── harness.test.js    # unit tests for Level 1 harness detection
    └── skills/
        ├── signin/SKILL.md
        ├── signout/SKILL.md
        ├── collect-export/SKILL.md
        ├── check-repo-scope/SKILL.md
        └── review-export/SKILL.md
```


## Testing

The suite uses the built-in Node test runner (`node:test`) with no external
dependencies. Run it from the repo root:

```bash
node --test plugins/skillmeter/test/*.test.js
```

Each suite isolates state by pointing `HOME` at a throwaway directory (so the
shared `~/.skillbench/credentials.json` is never touched) and seeds a device id
+ hash salt up front. Coverage spans JWT routing and the 401/403 retry, the
repo-scope privacy posture, poison-batch durability, pre-upload secret/PII
redaction (plus boundary/idempotency edge cases), path hashing and ingest-URL
resolution (`logger.test.js`), the verified Codex hook catalog
(`hook-surface.test.js`), the proactive license refresh + daemon lifecycle
(`retry-daemon.test.js`), the cross-platform consent prompts, Level 1 harness
detection, and the `bin/` auth/debug CLIs.

### Unattended / long-running sessions (zero-code re-mint)

Manual and long-lived test sessions can outlive both the license `exp` and the
`/refresh` sliding window. To keep them authenticated with **no interactive
sign-in**, authenticate the `gh` CLI once with the `read:org` scope:

```bash
gh auth login -s read:org          # fresh login
gh auth refresh -h github.com -s read:org   # add the scope to an existing login
```

With that scope present, `trySilentGhActivate` can re-mint a fresh license
silently once `/refresh` returns `410` (window lapsed) — the plugin fetches your
org memberships and re-activates without prompting, so a continuous session (or
a repeated test loop) never stalls on a device-flow login. Without `read:org`,
the silent path fails and the run falls back to the interactive device flow. Run
`node "$PLUGIN_ROOT/bin/sk-refresh"` to force this path on demand and confirm the
silent re-mint works in your environment.


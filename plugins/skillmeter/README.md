# SkillMeter


SkillMeter is the SkillBench **live telemetry plugin for Codex**. It records
anonymized lifecycle telemetry from your Codex sessions and forwards it to the
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
| `SessionStart` | A Codex session starts (`startup`, `resume`, `clear`, `compact`) | `source`, `model`, `permission_mode` |
| `UserPromptSubmit` | The user submits a prompt | `prompt`, `permission_mode` |
| `PreToolUse` | Before `Bash`, `apply_patch`, or an MCP tool runs | `tool_name`, sanitized `tool_input`, `tool_use_id` |
| `PermissionRequest` | Codex is about to ask for approval | `tool_name`, sanitized `tool_input`, approval `description` |
| `PostToolUse` | After a supported tool runs (success or failure) | `tool_name`, sanitized `tool_input`, sanitized `tool_response`, `tool_use_id` |
| `PreCompact` | Before context compaction | `trigger` (`manual` or `auto`) |
| `PostCompact` | After context compaction | `trigger` |
| `SubagentStart` | A subagent thread starts | `agent_id`, `agent_type` |
| `SubagentStop` | A subagent thread stops | `agent_id`, `agent_type`, `agent_transcript_path`, `stop_hook_active`, `last_assistant_message` |
| `Stop` | A turn stops | `stop_hook_active`, `last_assistant_message` |


Every event record also carries `session_id`, `device_id`, `agent: "codex"`,
the current `model` and `turn_id`, hashed `cwd`/`repo_root`, and the
`repo_scope` decision for the current project.


## Data flow


```text
Codex lifecycle event
  -> ${PLUGIN_ROOT}/scripts/<event>.js
  -> append NDJSON entry to ${PLUGIN_DATA}/logs/events.jsonl
  -> Stop / SubagentStop seal events.jsonl -> events.jsonl.<ts> and stage the
     transcript, then spawn a detached drain (drain_once.js) that gzips + POSTs
     to the resolved backend (default https://api.meter.skillbench.com/logs/codex)
  -> SkillBench Codex collector lambda
  -> OTel Collector
  -> ClickHouse skillmeter.otel_logs
  -> backend-analyzer
```


In ClickHouse, Codex events are attributed to their own
`ServiceName = skillmeter-codex-collector-<tenant>-<env>` (the collector derives
the service name from the event's `agent`), so Codex is queryable separately
from Claude Code while sharing the same `otel_logs` table.


### Durable uploads, background flush, and retry

The on-disk queues are the source of truth, so hooks never block on the network
and nothing is lost if an upload fails or a session crashes:

- **Sealing.** `Stop` / `SubagentStop` rename the active `events.jsonl` to a
  sealed batch `events.jsonl.<timestamp>` and write a sanitized transcript
  snapshot to `logs/transcripts/pending/`. No network call happens inline.
- **Background flush (one-shot drain).** Those hooks then spawn a detached
  `drain_once.js` that uploads every sealed log and pending transcript. On
  success a log is renamed to `.sent` and a transcript is deleted; on failure
  the file stays for the next attempt. A short-lived lock
  (`.drain-once.lock`) coalesces redundant spawns.
- **Retry monitor.** `SessionStart` launches a long-running, singleton
  `monitors/retry_daemon.js` that re-drains the queues on an interval, so a
  backend outage that clears mid-session still uploads without waiting for the
  next session. It is guarded by a heartbeat lock (`.retry-daemon.lock`) and
  self-terminates on idle or after a max lifetime (Codex has no managed monitor
  lifecycle to stop it).
- **Crash recovery.** `SessionStart` recovers an un-rotated `events.jsonl` left
  behind by a crashed/abandoned session (one idle beyond
  `SKILLMETER_ACTIVE_LOG_STALE_MS`) by sealing it into the drain queue.
- **Atomic writes.** Event records are appended in a single `O_APPEND` write and
  transcript snapshots / salvaged batches are written via a temp file + rename,
  so a concurrent writer or a crash mid-write can't leave interleaved or
  half-written ("invalid") lines that would later poison an upload.
- **Poison-batch handling.** A batch the backend permanently rejects (a 4xx
  other than 401/403/408/429) is never retried forever. The drain first attempts
  a *partial-rejection salvage* — it re-parses the batch line by line, drops only
  the malformed records, and retries the cleaned batch once. If that still fails
  (or the payload was already well-formed) the batch is *quarantined*: moved to
  `logs/poison/` so it stops consuming retry bandwidth while remaining available
  for forensics.
- **Retry & age limits.** Transient failures (5xx / 408 / 429 / network) are
  retried with the attempt count tracked in a `.meta` sidecar; a batch is
  quarantined once it exceeds `SKILLMETER_MAX_BATCH_RETRIES` attempts or its seal
  time is older than `SKILLMETER_BATCH_MAX_AGE_MS`, whichever comes first.
- **Cleanup.** Uploaded `.sent` logs, quarantined poison batches, orphaned
  `.meta`/temp files, and staged transcripts older than 30 days are pruned so
  disk usage stays bounded even if ingest is unavailable for weeks.

Hook failures never block your Codex session.


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
| `SKILLMETER_ACTIVATE_URL` | `https://api.skillbench.com/activate` | License activation endpoint (`/refresh` is derived from the same host) |
| `SKILLMETER_GITHUB_CLIENT_ID` | prod OAuth App | GitHub OAuth App client id used by the device-login flow |
| `SKILLMETER_TIMEOUT` | `10` | Event-batch upload timeout (seconds) |
| `SKILLMETER_MAX_BATCH_RETRIES` | `25` | Transient-failure attempts before a sealed batch is quarantined as poison |
| `SKILLMETER_BATCH_MAX_AGE_MS` | `1209600000` | Max age (14 days) an undeliverable batch/transcript is retried before being quarantined |
| `SKILLMETER_ACTIVE_LOG_STALE_MS` | `300000` | Idle age after which an un-rotated `events.jsonl` is treated as crash debris and recovered |
| `SKILLMETER_RETRY_DAEMON_INTERVAL_MS` | `120000` | Retry-monitor sweep interval |
| `SKILLMETER_RETRY_DAEMON_INITIAL_DELAY_MS` | `60000` | Retry-monitor delay before its first sweep (avoids racing the SessionStart drain) |
| `SKILLMETER_RETRY_DAEMON_MAX_IDLE_SWEEPS` | `15` | Empty sweeps before the retry monitor self-terminates |
| `SKILLMETER_RETRY_DAEMON_MAX_LIFETIME_MS` | `28800000` | Hard cap on retry-monitor lifetime |


The ingest endpoint is resolved at upload time in this order:

1. `SKILLMETER_BACKEND_URL` env var
2. `skillmeter.backendUrl` in `<project>/.codex/settings.local.json`
3. The `telemetry_endpoint` claim of a valid license JWT (per-tenant routing —
   see [Identity & authentication](#identity--authentication)), with the
   `/logs/codex` route appended
4. built-in default (prod): `https://api.meter.skillbench.com/logs/codex`

Steps 1–2 are user-supplied, so they're validated against a trusted-domain
allow-list. Step 3 is server-minted at sign-in and trusted as-is.

The shipped plugin defaults to prod. For local development, point a project at
the dev tenant collector with `skillmeter.backendUrl` (persistent, survives
hook spawns that don't inherit a shell env):

```json
{
  "skillmeter": {
    "backendUrl": "https://skillbench.meter.dev.skillbench.com/logs/codex"
  }
}
```


Per-project opt-in lives in `<project>/.codex/settings.local.json`:


```json
{
  "skillmeter": {
    "telemetry": true,
    "backendUrl": "https://skillbench.meter.dev.skillbench.com/logs/codex"
  }
}
```

Repo scope is **not** configured here — it derives from the GitHub identities of
the signed-in user (see [Repo-scoped filtering](#repo-scoped-filtering)).


You can toggle telemetry per-project with the bundled CLI:


```bash
node "$PLUGIN_ROOT/scripts/telemetry.js" enable
node "$PLUGIN_ROOT/scripts/telemetry.js" status
node "$PLUGIN_ROOT/scripts/telemetry.js" disable
```


On macOS, the very first `SessionStart` in a project shows a native consent
dialog. On other platforms the project starts in "not configured" state and you
must run `telemetry.js enable` once.


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

(or the `signout` skill). This drops the license JWT and org list and sets a
`signed_out` sentinel so a still-authenticated `gh` CLI doesn't silently
re-mint a license on the next session. The `device_id` and `hash_salt` are
preserved, so signing back in reuses the same machine identity.

### JWT refresh & token-clear-and-retry

- **Proactive refresh.** `SessionStart` rotates a missing or near-expiry JWT via
  the activation Lambda's `/refresh` endpoint (no GitHub round-trip), falling
  back to the silent `gh` path on `410`/`404`/network errors. Best-effort and
  non-blocking.
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
device ID and license JWT. There is no per-project repo-scope config, matching
the Claude Code plugin.

Events are dropped — even in projects where you ran `telemetry.js enable` — for:

- a machine that is not signed in (no allowed orgs cached → `not_activated`)
- directories that are not inside a Git repository
- repositories without a recognizable GitHub remote
- repositories whose remote belongs to an org the user is not a member of

To refresh the allowed identity list (e.g. after joining a new org), run the
`signin` skill again.


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
    │   ├── sanitizer.js
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
    │   └── durability.test.js # unit tests for poison-batch handling, salvage, retry/age limits, atomic writes
    └── skills/
        ├── signin/SKILL.md
        ├── signout/SKILL.md
        ├── collect-export/SKILL.md
        ├── check-repo-scope/SKILL.md
        └── review-export/SKILL.md
```


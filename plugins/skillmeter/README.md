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
- **Cleanup.** Uploaded `.sent` logs and staged transcripts older than 30 days
  are pruned so disk usage stays bounded even if ingest is unavailable for
  weeks.

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
| `SKILLMETER_TIMEOUT` | `10` | Event-batch upload timeout (seconds) |
| `SKILLMETER_ACTIVE_LOG_STALE_MS` | `300000` | Idle age after which an un-rotated `events.jsonl` is treated as crash debris and recovered |
| `SKILLMETER_RETRY_DAEMON_INTERVAL_MS` | `120000` | Retry-monitor sweep interval |
| `SKILLMETER_RETRY_DAEMON_INITIAL_DELAY_MS` | `60000` | Retry-monitor delay before its first sweep (avoids racing the SessionStart drain) |
| `SKILLMETER_RETRY_DAEMON_MAX_IDLE_SWEEPS` | `15` | Empty sweeps before the retry monitor self-terminates |
| `SKILLMETER_RETRY_DAEMON_MAX_LIFETIME_MS` | `28800000` | Hard cap on retry-monitor lifetime |


The ingest endpoint is resolved at upload time in this order:

1. `SKILLMETER_BACKEND_URL` env var
2. `skillmeter.backendUrl` in `<project>/.codex/settings.local.json`
3. built-in default (prod): `https://api.meter.skillbench.com/logs/codex`

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


Per-project opt-in and repo-scope settings live in the same
`<project>/.codex/settings.local.json`:


```json
{
  "skillmeter": {
    "telemetry": true,
    "backendUrl": "https://skillbench.meter.dev.skillbench.com/logs/codex",
    "repoScope": {
      "enabled": true,
      "allowedGitHubOrgs": ["your-company", "your-github-user"],
      "includeUnapprovedRepos": false
    }
  }
}
```


You can toggle telemetry per-project with the bundled CLI:


```bash
node "$PLUGIN_ROOT/scripts/telemetry.js" enable
node "$PLUGIN_ROOT/scripts/telemetry.js" status
node "$PLUGIN_ROOT/scripts/telemetry.js" disable
```


On macOS, the very first `SessionStart` in a project shows a native consent
dialog. On other platforms the project starts in "not configured" state and you
must run `telemetry.js enable` once.


## Privacy


- **Device ID and hash salt** are stored in
  `~/.skillbench/credentials.json` (mode `0600`) and shared with the SkillMeter
  Claude Code plugin so the SkillBench analyzer sees one device per machine.
- **Paths** (`cwd`, `repo_root`, `tool_input.file_path`, `command`, `patch`)
  are HMAC-SHA256 hashed with the per-machine salt before they leave the
  session.
- **Repo scope filtering** stops uploads from repos outside your allowed
  GitHub orgs. With no allow-list configured and `includeUnapprovedRepos:
  false`, scope-based blocking is the default — events get dropped at the hook
  rather than uploaded.
- **Trust review.** Codex skips plugin-bundled hooks until you review and
  trust the current hook definition via `/hooks`. Changing this plugin's hooks
  invalidates the trust and requires re-review.


## Bundled skills


The plugin still ships the existing workflow skills under `skills/`:


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
    │   ├── logger.js          # logging + durable queue/drain/retry transport
    │   ├── credstore.js
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
    └── skills/
        ├── collect-export/SKILL.md
        ├── check-repo-scope/SKILL.md
        └── review-export/SKILL.md
```


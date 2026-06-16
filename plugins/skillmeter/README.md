# SkillMeter


SkillMeter is the SkillBench plugin for Codex. It collects anonymized lifecycle
telemetry from your Codex sessions and forwards it to the SkillBench analyzer
so your weekly skill reports include Codex activity alongside Claude Code and
GitHub PR data.


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
  -> Stop / SubagentStop rotates events.jsonl and gzips + POSTs to the
     resolved backend (default https://api.meter.skillbench.com/logs/codex)
  -> SkillBench Codex collector lambda
  -> OTel Collector
  -> ClickHouse skillmeter.otel_logs
  -> backend-analyzer
```


Failed uploads are kept on disk as `events.jsonl.<timestamp>` and retried on
the next `SessionStart`.


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


These skills remain useful for batch exports and audit; the new hooks add the
real-time path on top of them.


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
    │   ├── logger.js
    │   ├── credstore.js
    │   ├── sanitizer.js
    │   ├── telemetry.js
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


# SkillMeter for Codex

SkillMeter is the SkillBench **telemetry plugin for Codex**. It records
anonymized lifecycle telemetry from your Codex sessions through Codex's plugin
hooks and forwards it to the SkillBench analyzer, so your skill reports include
Codex activity alongside Claude Code and GitHub PR data.

This is the Codex counterpart to the SkillMeter Claude Code plugin. It emits the
same NDJSON envelope to the same collector (tagged `agent: "codex"`), so both
agents land in one pipeline and are queryable side by side.

## What you get

- **Live telemetry** — every Codex lifecycle hook (session start, prompt
  submit, tool use, permission requests, compaction, subagents, stop) is
  captured, sanitized, and uploaded in the background.
- **Privacy by default** — paths and commands are HMAC-hashed, telemetry is
  opt-in per project, and repo-scope filtering keeps out-of-scope repos from
  ever uploading.
- **Complementary skills** — bundled `@skillmeter` skills still cover batch
  export, repo-scope checks, and export review for one-off audits.

See [`plugins/skillmeter/README.md`](plugins/skillmeter/README.md) for the full
event table, data flow, configuration, and privacy details.

## Install

If you already have the SkillBench session-collector installed, the easiest path
is:

```bash
skillbench codex plugin-install
```

This clones (or refreshes) this marketplace and runs the
`codex plugin marketplace add` step for you, then prints the next steps. Pass
`--dry-run` to print the commands without executing them.

To install manually:

```bash
codex plugin marketplace add SkillBench-AI/skillmeter-codex-marketplace
```

Then open Codex, run `/plugins`, choose the `SkillBench` marketplace, and
install `SkillMeter`. Codex lists the plugin's hooks under `/hooks` — they stay
inactive until you review and trust them, then start a fresh thread.

Codex currently installs plugins through the interactive plugin browser. There
is not a separate documented `codex plugin install ...` command for installing a
plugin entry directly by name.

## How it works

```text
Codex lifecycle event
  -> bundled hook script (scripts/<event>.js)
  -> sanitize + append NDJSON to a local queue
  -> Stop / SubagentStop gzip + POST the batch to the SkillBench Codex collector
  -> OTel Collector
  -> ClickHouse (ServiceName = skillmeter-codex-collector-<tenant>-<env>)
  -> SkillBench analyzer
```

Uploads are durable and non-blocking: `Stop`/`SubagentStop` seal events and
transcripts to disk and hand off to a detached drain, `SessionStart` recovers
un-rotated logs from crashed sessions and starts a background retry monitor, and
stale uploaded files are cleaned up after 30 days. Hook failures never block your
Codex session. See [`plugins/skillmeter/README.md`](plugins/skillmeter/README.md#durable-uploads-background-flush-and-retry)
for details.

## Telemetry control

Per-project opt-in and repo-scope settings live in
`<project>/.codex/settings.local.json` under the `skillmeter` namespace. On
macOS the first session in a project shows a native consent prompt; elsewhere,
enable it explicitly:

```bash
node "$PLUGIN_ROOT/scripts/telemetry.js" enable
node "$PLUGIN_ROOT/scripts/telemetry.js" status
node "$PLUGIN_ROOT/scripts/telemetry.js" disable
```

## Local development

Add this checkout as a marketplace source:

```bash
codex plugin marketplace add ./skillmeter-codex-marketplace
```

Then `/plugins` → install `SkillMeter` → start a fresh thread. Codex loads local
plugins from its plugin cache after installation, so reinstall (or refresh the
marketplace) after changing the plugin contents.

The shipped plugin uploads to prod by default. To point a project at a non-prod
collector (e.g. the dev tenant collector) without changing the default, set
`skillmeter.backendUrl` in that project's `.codex/settings.local.json` — see
[`plugins/skillmeter/README.md`](plugins/skillmeter/README.md#configuration).

## Bundled skills

The plugin still ships the original workflow skills, useful for batch exports
and audits on top of the live feed:

- `@skillmeter collect a sanitized export of my recent Codex sessions`
- `@skillmeter check whether this repo is in scope for skillbench-ai`
- `@skillmeter review dist/skillbench_export_sanitized_2026_W17.json`

## Repo Layout

```text
skillmeter-codex-marketplace/
├── .claude-plugin/marketplace.json
├── .agents/plugins/marketplace.json
└── plugins/skillmeter/
    ├── .codex-plugin/plugin.json
    ├── README.md
    ├── hooks/hooks.json
    ├── scripts/            # lifecycle hook handlers + logger/sanitizer/credstore
    └── skills/
        ├── collect-export/SKILL.md
        ├── check-repo-scope/SKILL.md
        └── review-export/SKILL.md
```

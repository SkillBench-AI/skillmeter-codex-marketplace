# SkillMeter for Codex

Codex marketplace package for `skillmeter`, the SkillBench workflow plugin for
collecting and reviewing sanitized AI session exports.

## Install

If you already have the SkillBench session-collector installed, the easiest
path is:

```bash
skillbench codex plugin-install
```

This clones (or refreshes) this marketplace and runs the
`codex plugin marketplace add` step for you, then prints the next steps.
Pass `--dry-run` to print the commands without executing them.

To install manually:

```bash
codex plugin marketplace add SkillBench-AI/skillmeter-codex-marketplace
```

Then open Codex, run `/plugins`, choose the `SkillBench` marketplace, and
install `SkillMeter`.

After install, start a new thread and invoke the plugin directly with
`@skillmeter` or one of its bundled skills.

Codex currently installs plugins through the interactive plugin browser. There
is not a separate documented `codex plugin install ...` command for installing a
plugin entry directly by name.

## Local Testing

For local development, add this checkout as a marketplace source:

```bash
codex plugin marketplace add ./skillmeter-codex-marketplace
```

Then open Codex, run `/plugins`, install `SkillMeter`, and start a fresh
thread. Codex loads local plugins from its plugin cache after installation, so
reinstall or refresh the marketplace after changing the plugin contents.

## What This Plugin Does

This Codex plugin bundles SkillBench workflows for:

- collecting sanitized exports from local Codex session logs
- checking whether a repo is inside your allowed GitHub org scope
- reviewing a sanitized export before upload

Unlike the Claude Code plugin, this package does not use runtime hooks. Codex
plugins currently center on skills, apps, and MCP servers, so SkillMeter for
Codex works by guiding Codex through the existing `session-collector` workflow
that reads Codex's native session history from `~/.codex/sessions`.

The plugin does not bundle a collector runtime of its own. It is a Codex-native
control surface for the existing SkillBench collection flow.

## Typical Use

1. Install the plugin from `/plugins`.
2. Start a new Codex thread.
3. Ask `@skillmeter` to collect, check repo scope, or review an export.

Example prompts:

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
    └── skills/
        ├── collect-export/SKILL.md
        ├── check-repo-scope/SKILL.md
        └── review-export/SKILL.md
```

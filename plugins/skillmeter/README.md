# SkillMeter

SkillMeter is a Codex plugin for SkillBench workflows.

It helps Codex:

- collect a sanitized export from local Codex session logs
- explain whether the current repo is inside an allowed GitHub org scope
- review a sanitized export before you upload it to SkillBench

## Prerequisites

SkillMeter for Codex expects the SkillBench collector workflow to be available.
That can be either:

- a local `skillbench` CLI installation, or
- a nearby checkout of the `session-collector` repository

The plugin guides Codex through that workflow; it does not embed a standalone
collector binary.

## Important Limitation

Codex plugins do not currently expose Claude-style runtime hooks. Because of
that, this plugin does not attempt to capture live events inside Codex.
Instead, it uses the existing SkillBench `session-collector` workflow, which
parses Codex's native session files under `~/.codex/sessions`.

## Bundled Skills

- `collect-export`: run the SkillBench collector and produce a sanitized export
- `check-repo-scope`: verify whether the current repo fits the allowed GitHub
  org filter
- `review-export`: inspect a sanitized export and summarize it before upload

## First Run

After installing the plugin in `/plugins`, start a fresh thread and invoke:

- `@skillmeter collect a sanitized export for this workspace`

If the collector is already installed, Codex can use it immediately. If not,
the plugin steers Codex toward the documented `session-collector` install flow.

## Example Prompts

- `@skillmeter collect a sanitized export for this workspace`
- `@skillmeter check whether this repo is in scope for skillbench-ai`
- `@skillmeter review this export file before I upload it`

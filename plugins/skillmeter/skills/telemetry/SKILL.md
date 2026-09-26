---
name: telemetry
description: Show SkillMeter collection status for the current repository, or enable, disable, pause and resume Codex telemetry.
---

Run these controls from the repository the user is asking about. The script
resolves the nearest Git root from the working directory and takes no path
argument. It prints to stderr; report the output verbatim in a fenced code
block and add nothing it does not say.

## Status

```sh
node "$PLUGIN_ROOT/scripts/telemetry.js" status
```

`status` is read-only and changes no credentials or settings. It reports the
capture policy for this repository, delivery authentication, and the local
upload queue across repositories. It does not verify hook execution, server
acceptance or report generation; do not claim delivery from an empty queue.

## Enable or disable this repository

Change a repository choice only when the user explicitly asks for it. If the
status line says a repository choice is required, describe what is collected
(see the plugin README) and wait for the user's decision. Sign-in and an
in-scope repository do not imply consent.

```sh
node "$PLUGIN_ROOT/scripts/telemetry.js" enable
node "$PLUGIN_ROOT/scripts/telemetry.js" disable
```

The choice is stored per checkout in `.codex/settings.local.json`; clones and
linked worktrees need their own choice. Before running `disable`, tell the user
that it removes this repository's queued, unsent payloads, that requests already
in flight may finish, and that re-enabling does not restore removed payloads.
Enabling cannot bring an out-of-scope
repository into scope, and the global pause still applies.

## Pause or resume all collection on this machine

```sh
node "$PLUGIN_ROOT/scripts/telemetry.js" disable --global
node "$PLUGIN_ROOT/scripts/telemetry.js" enable --global
```

The global pause stops capture and uploads for every repository and keeps
queued data. Requests already in flight may finish. Resuming allows later
delivery attempts when authentication and connectivity permit; it does not
guarantee delivery. After any change, run `status` and report the new capture
policy line.

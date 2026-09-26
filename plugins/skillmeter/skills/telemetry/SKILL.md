---
name: telemetry
description: Show SkillMeter collection status for the current repository, record a shared consent choice for it, or enable, disable, pause and resume Codex telemetry.
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

## Shared consent for this repository

Use this when the user wants one choice for this repository across every
SkillMeter client and every clone or worktree on this machine. Change it only
when the user explicitly asks. Never pick ON or OFF for them.

1. Preview. `consent-preview` is read-only.

   ```sh
   node "$PLUGIN_ROOT/scripts/telemetry.js" consent-preview --json
   ```

   Tell the user, in plain words: the `repository` key, the `sharedRevision`,
   every entry in `localChoices`, and every `notices` message. If `repository`
   is null, stop and relay the `repository_unavailable` notice.

2. Ask for an explicit choice: ON or OFF for this repository.

3. For ON, show this statement verbatim and ask the user to confirm it:

   > Telemetry choices apply to every SkillMeter client on this machine
   > (Claude Code and Codex) and to every clone or worktree of the repository.

   Pass `--acknowledge-machine-scope` only after the user confirms that
   statement in this conversation. Never infer it from the ON request itself.
   For OFF, tell the user that it removes this repository's queued, unsent
   payloads for every clone and worktree, that requests already in flight may
   finish, and that turning it on again does not restore removed payloads.
   OFF needs no acknowledgement.

4. Apply, using the key and revision from that same preview. Use `absent` when
   `sharedRevision` is null.

   ```sh
   node "$PLUGIN_ROOT/scripts/telemetry.js" consent-set on --repository KEY --revision REVISION --acknowledge-machine-scope
   node "$PLUGIN_ROOT/scripts/telemetry.js" consent-set off --repository KEY --revision REVISION
   ```

   Report the output verbatim in a fenced code block.

If the command fails, relay the code and message, then act on it:

- `STALE_POLICY`: the shared choices changed. Run the preview again, show the
  new state and ask again. Never retry the old revision.
- `REPOSITORY_CHANGED` or `REPOSITORY_UNAVAILABLE`: run the preview again from
  the repository the user means; check sign-in, organization scope and remotes.
- `ACKNOWLEDGEMENT_REQUIRED`: the statement above was not confirmed.
- `LOCAL_CONSENT_CONFLICT`: a local OFF or invalid setting in this checkout
  still restricts it. Show the `localChoices` entries; the user must resolve
  them explicitly (for example with `enable` below) before shared ON.
- `ORGANIZATION_CONSENT_REQUIRED`: the organization has not been authorized at
  consent version 2. That happens in the Claude Code plugin's telemetry
  controls; this command cannot authorize an organization.
- `INVALID_ARGUMENTS`: check the key and revision against the preview.

A saved choice does not prove hook execution or delivery. Local restrictions
still apply, and legacy shared choices keep the per-checkout requirement.

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

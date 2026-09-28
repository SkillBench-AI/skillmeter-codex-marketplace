---
name: telemetry
description: Show SkillMeter collection status for the current repository, record Codex organization and repository consent, or restrict, pause and resume Codex telemetry.
---

`<plugin-root>` in the commands below is this plugin's installed root: the
absolute path of the directory two levels above this `SKILL.md`. Substitute it
yourself; `$PLUGIN_ROOT` is not set in the shell that runs skill commands.

Run these controls from the repository the user is asking about. The script
resolves the nearest Git root from the working directory and takes no path
argument. `status`, `enable` and `disable` print to stderr; `consent-preview` and
`consent-set` print to stdout. Report the output verbatim in a fenced code block
and add nothing it does not say.

These controls change only SkillMeter for Codex. SkillMeter for Claude Code
keeps its own consent choices and is not affected.

## Status

```sh
node "<plugin-root>/scripts/telemetry.js" status
```

`status` is read-only and changes no credentials or settings. It prints a short
card: the capture state for this repository, the reason when capture is not on,
sign-in, and the local upload queue. Show the card as is. Run
`status --details` only when the user asks for diagnostics; it adds transcript
health and delivery lines. Neither verifies hook execution, server acceptance or
report generation; do not claim delivery from an empty queue.

## Record consent for this repository

Capture needs two choices in Codex's consent record: the repository's
organization ON, then the repository ON. Change them only when the user
explicitly asks. Never pick ON or OFF for them. Sign-in and an in-scope
repository do not imply consent; describe what is collected (see the plugin
README) before asking.

1. Preview. `consent-preview` is read-only.

   ```sh
   node "<plugin-root>/scripts/telemetry.js" consent-preview --json
   ```

   Tell the user, in plain words: the `repository` key, the `sharedRevision`,
   every entry in `localChoices`, and every `notices` message. Stop and relay
   the notices instead of asking for a choice when `repository` is null
   (`repository_unavailable`) or when the result has no `sharedRevision`
   property at all: that means the consent record is unreadable, malformed or
   missing after it was seen, and it must be repaired first. A `sharedRevision`
   of `null` is different: no choice has been recorded yet.

2. Ask for an explicit choice: ON or OFF. The organization is the second
   segment of the repository key.

3. For ON, show this statement verbatim and ask the user to confirm it:

   > This choice applies to SkillMeter for Codex on this machine and to every
   > clone or worktree of the repository. It does not change SkillMeter for
   > Claude Code.

   Pass `--acknowledge-machine-scope` only after the user confirms that
   statement in this conversation. Never infer it from the ON request itself.
   For OFF, tell the user that it removes the queued, unsent payloads this
   plugin attributed to the repository (or to every repository of the
   organization), for every clone and worktree; that cleanup blocked by an
   upload in progress is deferred to the next drain, which rechecks consent
   before sending; that requests already in flight may finish; and that
   turning it on again does not restore removed payloads. OFF needs no
   acknowledgement.

4. Apply, using the revision from the latest preview. Use `absent` when
   `sharedRevision` is null. Record the organization first; each write changes
   the revision, so run the preview again before the repository step.

   ```sh
   node "<plugin-root>/scripts/telemetry.js" consent-set on --organization ORG --revision REVISION --acknowledge-machine-scope
   node "<plugin-root>/scripts/telemetry.js" consent-set on --repository KEY --revision REVISION --acknowledge-machine-scope
   node "<plugin-root>/scripts/telemetry.js" consent-set off --repository KEY --revision REVISION
   node "<plugin-root>/scripts/telemetry.js" consent-set off --organization ORG --revision REVISION
   ```

   Each command prints a short result card. Show it verbatim in a fenced code
   block and add nothing it does not say.

If the command fails, relay the code and message, then act on it:

- `STALE_POLICY`: the choices changed. Run the preview again, show the new
  state and ask again. Never retry the old revision.
- `REPOSITORY_CHANGED` or `REPOSITORY_UNAVAILABLE`: run the preview again from
  the repository the user means; check sign-in, organization scope and remotes.
- `ORGANIZATION_UNAVAILABLE`: the license does not cover that organization, or
  scope settings exclude it. Suggest checking `sk-jwt` and sign-in.
- `ORGANIZATION_CONSENT_REQUIRED`: record the organization ON first.
- `ACKNOWLEDGEMENT_REQUIRED`: the statement above was not confirmed.
- `LOCAL_CONSENT_CONFLICT`: a local OFF or invalid setting in this checkout
  still restricts it. Show each `localChoices` entry whose choice is `off` or
  `invalid`, with its path relative to the repository root. The user must edit
  or remove that exact file before ON; `enable` writes only the root file and
  cannot resolve a descendant or an unparsable file. Do not edit or delete
  these files yourself unless the user asks.
- `INVALID_ARGUMENTS`: check the organization, key and revision against the
  preview.

A saved choice does not prove hook execution or delivery. Local restrictions
still apply.

## Restrict this checkout

```sh
node "<plugin-root>/scripts/telemetry.js" disable
node "<plugin-root>/scripts/telemetry.js" enable
```

`disable` writes a local OFF to this checkout's `.codex/settings.local.json`,
which blocks capture here even when the repository is ON. `enable` clears that
root-level OFF; it does not grant capture on its own. Before running `disable`,
tell the user that it removes this repository's queued, unsent payloads, that
requests already in flight may finish, and that re-enabling does not restore
removed payloads.

## Pause or resume all Codex collection on this machine

```sh
node "<plugin-root>/scripts/telemetry.js" disable --global
node "<plugin-root>/scripts/telemetry.js" enable --global
```

The global pause stops Codex capture and uploads for every repository and
keeps queued data. It does not pause SkillMeter for Claude Code. Requests
already in flight may finish. Resuming allows later delivery attempts when
authentication and connectivity permit; it does not guarantee delivery. After
any change, run `status` and show its card.

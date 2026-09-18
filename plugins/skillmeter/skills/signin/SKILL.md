---
name: signin
description: Sign in to SkillMeter with GitHub so Codex telemetry is authenticated and routed to your tenant.
---

Run GitHub sign-in when the user wants to authenticate SkillMeter or recover
rejected uploads:

```sh
node "$PLUGIN_ROOT/scripts/signin.js"
```

To narrow collection to selected GitHub organizations, pass `--org` (repeatable
or comma-separated). It intersects with actual memberships; on an existing
sign-in it updates stored scope without repeating authentication:

```sh
node "$PLUGIN_ROOT/scripts/signin.js" --org your-github-org
```

The script uses the authenticated GitHub CLI when available, otherwise a device
flow. Relay the device code and verification URL verbatim. When prompted,
tell the user to approve in their browser and re-run sign-in to confirm.

Successful sign-in stores the license and organization scope in the shared
`~/.skillbench/credentials.json` and clears the global telemetry pause.
Uploads use the license's `aud` claim for tenant routing.

If the script prints a welcome banner, reproduce it in a fenced code block to
preserve alignment. Report the result without exposing credentials.

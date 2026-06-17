---
name: signout
description: Sign out of SkillMeter and stop authenticating Codex telemetry uploads.
---

Use this skill when the user wants to sign out of SkillMeter or revoke the
machine's stored license.

Run the SkillMeter sign-out script:

```bash
node "$PLUGIN_ROOT/scripts/signout.js"
```

What it does:

- Drops the stored license JWT and the cached GitHub-org list.
- Sets a `signed_out` sentinel so the next session does NOT silently re-mint a
  license from a still-authenticated `gh` CLI.
- Preserves the machine `device_id` and `hash_salt`, so signing back in reuses
  the same identity.

After sign-out, uploads fall back to the unauthenticated default endpoint until
the user runs the sign-in flow again. Report the script's result to the user.

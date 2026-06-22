---
name: signout
description: Sign out of SkillMeter and stop all Codex telemetry uploads on this machine.
---

Use this skill when the user wants to sign out of SkillMeter, revoke the
machine's stored license, or stop all telemetry uploads on the machine.

Run the SkillMeter sign-out script:

```bash
node "$PLUGIN_ROOT/scripts/signout.js"
```

What it does:

- Drops the stored license JWT and the cached GitHub-org list.
- Sets a `signed_out` sentinel so the next session does NOT silently re-mint a
  license from a still-authenticated `gh` CLI.
- Enables the machine-global telemetry kill-switch, leaving pending uploads
  queued until the user signs in or runs the global enable command.
- Preserves the machine `device_id` and `hash_salt`, so signing back in reuses
  the same identity.

After sign-out, hooks and background drains skip telemetry uploads until the
user runs the sign-in flow again. Report the script's result to the user.

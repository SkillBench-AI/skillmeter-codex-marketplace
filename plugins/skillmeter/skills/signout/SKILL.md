---
name: signout
description: Sign SkillMeter out of Codex on this machine.
---

Run the sign-out script when the user wants to sign SkillMeter out of Codex:

```sh
node "$PLUGIN_ROOT/scripts/signout.js"
```

This ends Codex's SkillMeter session, deletes event batches that were recorded
but not sent, and revokes the session at the sign-in service. The device
identity and consent choices remain. Other SkillMeter clients on the machine
stay signed in. To pause Codex uploads without signing out, use
`sk-telemetry disable --global`.

Report the result. Recording and uploads resume after signing in again.

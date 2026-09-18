---
name: signout
description: Sign out of SkillMeter and stop all Codex telemetry uploads on this machine.
---

Run the sign-out script when the user wants to remove the stored SkillMeter
license and stop collection on this machine:

```sh
node "$PLUGIN_ROOT/scripts/signout.js"
```

This removes the shared license and organization list, pauses telemetry, and
blocks silent GitHub reactivation. Device ID, hash salt and queued uploads remain.
Because Claude and Codex share credentials, removing the license affects both.

Report the result. Resuming the global toggle alone does not restore credentials;
uploads require signing in again.

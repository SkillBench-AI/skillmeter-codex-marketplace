---
name: signin
description: Sign in to SkillMeter through the SkillBench sign-in service so Codex telemetry is authenticated and routed to your workspace.
---

Run sign-in when the user wants to authenticate SkillMeter, when SkillMeter
reports that sign-in is required, or to recover rejected uploads:

```sh
node "$PLUGIN_ROOT/scripts/signin.js"
```

The script starts a device sign-in. Relay the code and the verification URL
verbatim, tell the user to approve in their browser (choosing the workspace
there when asked), and re-run sign-in to confirm.

Successful sign-in stores this plugin's session (the license and the sign-in
service's refresh token) in `~/.skillbench/clients/codex/`. It is not shared
with other SkillMeter clients. Repository capture is limited to the GitHub
organizations the workspace has connected; uploads are routed by the license's
`aud` claim.

Sign-in does not create consent. Organization and repository ON already recorded
in Codex may allow capture once authentication recovers. Check `sk-telemetry
status` and `consent-preview` first. If consent is missing, explain the data
collected in the README and obtain the user's explicit choice through the
telemetry skill. Consent recorded in SkillMeter for Claude Code does not apply
here. Do not infer capture consent from a request to sign in.

If the script prints a welcome banner, reproduce it in a fenced code block to
preserve alignment. Report the result without exposing credentials.

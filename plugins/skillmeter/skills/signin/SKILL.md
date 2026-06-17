---
name: signin
description: Sign in to SkillMeter with GitHub so Codex telemetry is authenticated and routed to your tenant.
---

Use this skill when the user wants to sign in to SkillMeter, authenticate Codex
telemetry, or fix uploads that are being rejected/unauthenticated.

Run the SkillMeter sign-in flow:

```bash
node "$PLUGIN_ROOT/scripts/signin.js"
```

What it does:

1. Tries a silent sign-in via `gh auth token` when the GitHub CLI is already
   authenticated.
2. Otherwise prints a GitHub device-login code and verification URL. Relay the
   code and URL to the user verbatim so they can approve in their browser.
3. On approval it exchanges the GitHub token for a SkillMeter license JWT and
   stores it (with the user's GitHub orgs) in `~/.skillbench/credentials.json`.

After sign-in, every Codex upload is authenticated with the license JWT and
routed to the per-tenant endpoint carried in the JWT's `telemetry_endpoint`
claim — no further configuration needed.

Reporting:

- If the output contains the ASCII welcome banner (box-drawing characters),
  reproduce it verbatim inside a fenced code block so the alignment is
  preserved.
- If the output asks the user to approve a device code on GitHub, surface the
  code, the URL, and the instruction to re-run sign-in to confirm.

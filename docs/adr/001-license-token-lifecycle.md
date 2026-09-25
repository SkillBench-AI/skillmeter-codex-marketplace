# License Token Lifecycle: Lifetime, Refresh, and Recovery

**Status:** Adopted by reference. Canonical text:
[Claude Code plugin ADR 001](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/main/docs/adr/001-license-token-lifecycle.md)
(Accepted 2026-09-10, amended 2026-09-16: sign-in moved to the broker).
**Tracker:** INF-177 (alignment of this plugin and the VS Code extension),
INF-232

## What is the same

The credential file `~/.skillbench/credentials.json`, the device id and the
hash salt are shared with the Claude Code plugin (decision 5). The retry daemon
(`scripts/monitors/retry_daemon.js`) refreshes the token in the background
independent of queue state (decision 2). Hooks record while a token exists;
freshness is enforced at transmission (decision 3, covered by #46). `status`
separates capture policy from delivery readiness (#47).

## Differences in the Codex plugin

- Sign-out sets `telemetry_disabled` in the credential file, which is this
  plugin's global upload pause, and advances the authentication generation
  that the consent journal reads. The Claude plugin sets `signed_out` and
  purges its audit queue instead. The purge of unsent data on sign-out and
  402 (decision 3) is not implemented here.
- Re-activation without a stored token still exists and is not bound to the
  prior identity. The canonical amendment retired that path for the Claude
  plugin; the broker sign-in for this plugin follows the auth work tracked in
  INF-232 and INF-177.
- Same-principal sign-out and sign-in closes a consent-journal interval
  (`docs/repository-consent.md`); an ordinary refresh does not.

## Open items

- Broker sign-in and identity-bound re-activation (INF-177).
- Purge on sign-out and 402, and the 7-day age bound for unsent data.

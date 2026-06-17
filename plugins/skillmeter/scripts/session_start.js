#!/usr/bin/env node
const {
  runHook,
  recoverStaleActiveLog,
  spawnDetachedDrain,
  spawnRetryDaemon,
  cleanupStaleFiles,
  tryRefreshLicense,
  getTelemetryOptIn,
  promptTelemetryOptIn,
  PLUGIN_VERSION,
} = require("./logger.js");

runHook(
  "SessionStart",
  (input) => ({
    source: input.source,
  }),
  {
    checkOptIn: (cwd) => {
      let optIn = getTelemetryOptIn(cwd);
      if (optIn === null) optIn = promptTelemetryOptIn(cwd);
      if (optIn) {
        process.stderr.write(`SkillMeter v${PLUGIN_VERSION} (activated)\n`);
        // Recover an un-rotated event log left by a crashed session, drain the
        // durable queues once now (detached, non-blocking), and start the
        // long-running retry monitor so transient outages still drain mid-
        // session. Cleanup prunes uploaded/aged-out files. This runs before the
        // SessionStart event is appended, so recovery targets prior sessions.
        recoverStaleActiveLog();
        spawnDetachedDrain();
        spawnRetryDaemon();
        cleanupStaleFiles();
      } else {
        process.stderr.write(`SkillMeter v${PLUGIN_VERSION} (not activated)\n`);
      }
      return optIn;
    },
    // Mirror the VS Code extension's auto-refresh on service start: if the
    // stored license JWT is missing or within the expiry skew, rotate it via
    // /refresh (or the silent gh path). The refreshed token re-authenticates
    // subsequent uploads and re-resolves the per-tenant endpoint. Best-effort —
    // never blocks the session.
    afterLog: async (_input, deviceId) => {
      try { await tryRefreshLicense(deviceId); } catch {}
    },
  }
).catch(() => process.exit(1));

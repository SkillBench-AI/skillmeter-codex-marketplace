#!/usr/bin/env node
const {
  runHook,
  recoverStaleActiveLog,
  spawnDetachedDrain,
  spawnRetryDaemon,
  cleanupStaleFiles,
  tryRefreshLicense,
  writeTelemetryConsentFallback,
  PLUGIN_ROOT,
  PLUGIN_VERSION,
} = require("./logger.js");
const { detectHarness } = require("./harness.js");

runHook(
  "SessionStart",
  (input, ctx) => ({
    source: input.source,
    // Harness metadata (SBEE-163): presence/shape of the developer's harness
    // (instruction files, skills, hooks, plugin/agent info). Detected once at
    // session start and attached here so it flows through the same
    // sanitizeEventData boundary as every other event field. Metadata only —
    // no raw harness file contents.
    harness: detectHarness(ctx.cwd, {
      hashSalt: ctx.hashSalt,
      pluginRoot: PLUGIN_ROOT,
      pluginVersion: PLUGIN_VERSION,
      agentType: input.agent_type,
      agentVersion: input.version || process.env.CODEX_VERSION || "",
      model: input.model,
      sessionSource: input.source,
    }),
  }),
  {
    // React to the gate runHook already resolved (capture decision stays
    // central — runHook exits when gate.capture is false regardless). Consent is
    // in-context only: opted-in or owned-org auto-enable captures; otherwise we
    // print the enable/disable commands and stay "not configured". No OS dialog.
    onGate: ({ gate, cwd }) => {
      if (gate.capture) {
        const note =
          gate.mode === "auto_org"
            ? "(telemetry auto-enabled — repo owned by allowed org)"
            : "(activated)";
        process.stderr.write(`SkillMeter v${PLUGIN_VERSION} ${note}\n`);
        // Recover an un-rotated event log left by a crashed session, drain the
        // durable queues once now (detached, non-blocking), and start the
        // long-running retry monitor so transient outages still drain mid-
        // session. Cleanup prunes uploaded/aged-out files. This runs before the
        // SessionStart event is appended, so recovery targets prior sessions.
        recoverStaleActiveLog();
        spawnDetachedDrain();
        spawnRetryDaemon();
        cleanupStaleFiles();
        return;
      }
      if (gate.mode === "opted_out") {
        process.stderr.write(
          `SkillMeter v${PLUGIN_VERSION} (telemetry disabled for this project)\n`
        );
        return;
      }
      // not_enabled: no explicit opt-in and repo not owned by an allowed org.
      process.stderr.write(
        `SkillMeter v${PLUGIN_VERSION} (telemetry not configured for this project)\n`
      );
      writeTelemetryConsentFallback(cwd);
    },
    // Mirror the VS Code extension's auto-refresh on service start: if the
    // stored license JWT is missing or within the expiry skew, rotate it via
    // /refresh (or the silent gh path). The refreshed token re-authenticates
    // subsequent uploads and re-resolves the per-tenant endpoint. Best-effort —
    // never blocks the session. Fire-and-forget: don't await completion.
    afterLog: (_input, deviceId) => {
      tryRefreshLicense(deviceId).catch(() => {});
    },
  }
).catch(() => process.exit(1));

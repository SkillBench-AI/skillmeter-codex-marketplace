#!/usr/bin/env node
const {
  runHook,
  recoverStaleActiveLog,
  spawnDetachedDrain,
  spawnRetryDaemon,
  cleanupStaleFiles,
  tryRefreshLicense,
  writeTelemetryConsentFallback,
  getDeviceId,
  getTelemetryGloballyDisabled,
  PLUGIN_ROOT,
  PLUGIN_VERSION,
} = require("./logger.js");
const { detectHarness } = require("./harness.js");

// Pre-hook work: rotate a missing/near-expiry license JWT via /refresh (or the
// silent gh fallback) BEFORE the SessionStart event is built, gated, and logged.
// Mirrors the Claude plugin's awaited prepareSession(): earlier this ran
// fire-and-forget from afterLog, so the triggering session kept running with the
// still-expired token and its own SessionStart event was uploaded unauthenticated
// (transferEventLog drops an expired JWT before sending). Awaiting the refresh
// here persists the fresh token first, so the current session's event uploads
// authenticated and later drains re-resolve the per-tenant endpoint.
//
// Best-effort by construction: tryRefreshLicense is internally bounded (the
// /refresh call has a 5s AbortSignal.timeout) and swallows every failure to
// null; the surrounding Codex hook timeout (~10s) is the hard ceiling. This
// never throws and never blocks the session on a hung network.
async function prepareSession() {
  const deviceId = getDeviceId();
  if (!deviceId || getTelemetryGloballyDisabled()) return;
  try {
    await tryRefreshLicense(deviceId);
  } catch {}
}

function buildSessionStartEvent(input, ctx) {
  return {
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
  };
}

// React to the gate runHook already resolved (capture decision stays central —
// runHook exits when gate.capture is false regardless). Consent is in-context
// only: opted-in or owned-org auto-enable captures; otherwise we print the
// enable/disable commands and stay "not configured". No OS dialog.
function onGate({ gate, cwd }) {
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
}

function runSessionStartHook() {
  return runHook("SessionStart", buildSessionStartEvent, { onGate });
}

// Refresh the license first (awaited), then run the telemetry hook. Sequenced
// so the fresh token is persisted before runHook resolves the gate and appends
// the SessionStart event, matching the Claude plugin. prepareSession never
// rejects, but .catch keeps the finally chain honest.
function main() {
  return prepareSession()
    .catch(() => {})
    .finally(() => {
      runSessionStartHook().catch(() => process.exit(1));
    });
}

if (require.main === module) {
  main();
}

module.exports = { prepareSession, buildSessionStartEvent, onGate, main };

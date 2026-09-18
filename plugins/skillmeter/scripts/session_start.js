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

// Await refresh before evaluating capture scope or building SessionStart.
// Refresh errors are ignored; upload callers still enforce token validity.
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
    // Collect configuration names/counts and bounded custom skill bodies.
    // runHook sanitizes this block with the rest of the event.
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

// Report the capture decision already resolved by runHook.
function onGate({ gate, cwd }) {
  if (gate.capture) {
    const note =
      gate.mode === "auto_org"
        ? "(telemetry auto-enabled — repo owned by allowed org)"
        : "(activated)";
    process.stderr.write(`SkillMeter v${PLUGIN_VERSION} ${note}\n`);
    // Recover prior queues before appending this SessionStart event.
    // Detached workers handle uploads and retries.
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

// Attempt refresh before logging; a refresh failure must not skip the hook.
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

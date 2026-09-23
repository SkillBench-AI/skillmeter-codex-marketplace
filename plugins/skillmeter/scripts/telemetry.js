#!/usr/bin/env node
/**
 * Set project consent in .codex/settings.local.json or the shared global pause.
 * Usage: node scripts/telemetry.js <enable|disable|status> [--global].
 */

const {
  getTelemetryOptIn,
  getTelemetryGloballyDisabled,
  saveTelemetryOptIn,
  setTelemetryGloballyDisabled,
  SETTINGS_RELATIVE,
  getRepoScopeDecision,
  resolveTelemetryGate,
  isLicenseRejected,
  listPendingTranscripts,
  LOG_DIR,
  LOG_FILE,
  findGitRoot,
} = require("./logger.js");
const {
  getLicenseToken,
  isLicenseTokenExpired,
  getSignedOut,
  refreshFromDisk,
} = require("./credstore.js");

const fs = require("fs");
const path = require("path");
const { isJwtExpired } = require("./lib/jwt");
const { readSharedGlobalPolicy } = require("./lib/shared-telemetry-policy");

const cwd = process.cwd();
const projectRoot = findGitRoot(cwd) || cwd;
const action = process.argv[2];
const isGlobal = process.argv.slice(3).includes("--global");

function authenticationLine() {
  if (getSignedOut()) return "signed out; run the signin skill";
  const token = getLicenseToken();
  if (!token) return "no license; run the signin skill";
  if (isLicenseRejected()) return "paused; server rejected license, refresh required";
  if (isJwtExpired(token)) return "paused; license expired or invalid, refresh required";
  if (isLicenseTokenExpired(token)) return "refresh due; license still within the upload validity window";
  return "license locally valid; server acceptance not verified";
}

function sharedPauseLine() {
  const policy = readSharedGlobalPolicy();
  if (policy.reason === "invalid") return "shared policy invalid or unreadable; capture and delivery paused; repair the policy file";
  if (policy.disabled) return "shared policy paused; resume global telemetry through the shared policy controls";
  return null;
}

function capturePolicyLine() {
  const shared = sharedPauseLine();
  if (shared) return shared;
  if (getTelemetryGloballyDisabled()) return "globally disabled";
  const scope = getRepoScopeDecision(cwd);
  const gate = resolveTelemetryGate(getTelemetryOptIn(cwd), scope.allowed);
  if (gate.mode === "opted_out") return "disabled for this project";
  if (!scope.allowed) return `excluded (${scope.classification})`;
  if (!gate.capture) return "disabled; repository choice required";
  return "eligible for this repository; hook execution not verified";
}

function queueLines() {
  try {
    let entries = [];
    try { entries = fs.readdirSync(LOG_DIR); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const batches = entries.filter(name => /^events\.jsonl\.\d+$/.test(name) && fs.statSync(path.join(LOG_DIR, name)).isFile()).length;
    const chunks = listPendingTranscripts().length;
    let active = false;
    try { active = fs.statSync(LOG_FILE).size > 0; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return [
      `Upload queue (all repositories): ${batches} sealed event ${batches === 1 ? "batch" : "batches"}, ${chunks} transcript chunks`,
      `Unsealed event data: ${active ? "present" : "none"}`,
    ];
  } catch {
    return ["Upload queue: unavailable; could not read local queue state"];
  }
}

function saveRepositoryChoice(value) {
  try {
    saveTelemetryOptIn(cwd, value);
    return true;
  } catch (error) {
    if (error.message === "repository-routing-busy") {
      process.stderr.write("SkillMeter: Repository controls are busy; retry this command.\n");
    } else {
      process.stderr.write(`SkillMeter: Could not update ${SETTINGS_RELATIVE}; check local routing state, JSON and file permissions.\n`);
    }
    process.exitCode = 1;
    return false;
  }
}

switch (action) {
  case "enable":
    if (isGlobal) {
      setTelemetryGloballyDisabled(false);
      const shared = sharedPauseLine();
      process.stderr.write(shared ? `SkillMeter: Local pause cleared; ${shared}\n` : "SkillMeter: Global telemetry uploads enabled for this machine\n");
    } else {
      if (!saveRepositoryChoice(true)) break;
      process.stderr.write(`SkillMeter: Repository choice saved for ${projectRoot}\n`);
      process.stderr.write(`           (saved to ${SETTINGS_RELATIVE}; scope and global pause still apply)\n`);
      if (getTelemetryOptIn(cwd) !== true) {
        process.stderr.write("SkillMeter: A subdirectory setting still blocks capture here; review its telemetry setting.\n");
      }
      if (getTelemetryGloballyDisabled()) {
        process.stderr.write(
          sharedPauseLine() ? `SkillMeter: ${sharedPauseLine()}\n` :
          "SkillMeter: Global telemetry is still disabled; run with --global to resume uploads\n"
        );
      }
    }
    break;
  case "disable":
    if (isGlobal) {
      setTelemetryGloballyDisabled(true);
      process.stderr.write("SkillMeter: Global telemetry uploads disabled for this machine\n");
      process.stderr.write("SkillMeter: Pending uploads will remain queued until global telemetry is enabled\n");
    } else {
      if (!saveRepositoryChoice(false)) break;
      process.stderr.write(`SkillMeter: New capture disabled for ${projectRoot}; queued repository payloads revoked (in-flight requests may finish)\n`);
    }
    break;
  case "status": {
    // Status must not migrate credentials from Keychain or change shared state.
    refreshFromDisk();
    const lines = [
      `Capture policy: ${capturePolicyLine()}`,
      `Delivery authentication: ${authenticationLine()}`,
      ...queueLines(),
      "Last successful upload: unknown (not tracked by this version)",
      "An empty queue does not prove delivery or report generation.",
    ];
    for (const line of lines) process.stderr.write(`SkillMeter: ${line}\n`);
    break;
  }
  default:
    process.stderr.write("Usage: node telemetry.js <enable|disable|status> [--global]\n");
    process.exit(1);
}

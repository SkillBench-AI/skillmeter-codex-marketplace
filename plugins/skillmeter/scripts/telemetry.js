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
  findGitRoot,
} = require("./logger.js");
const {
  getAllowedGitHubOrgs,
  getLicenseToken,
  isLicenseTokenExpired,
  getSignedOut,
} = require("./credstore.js");

const cwd = process.cwd();
const projectRoot = findGitRoot(cwd) || cwd;
const action = process.argv[2];
const isGlobal = process.argv.slice(3).includes("--global");

// Repo-scope is gated entirely by the signed-in user's GitHub identities (their
// login + org memberships captured at signin), not per-project config. Surface
// that state so `status` explains why events may be dropped even when the
// project is opted in.
function repoScopeLine() {
  if (getSignedOut()) return "signed out — run the signin skill (all events dropped)";
  const token = getLicenseToken();
  if (!token) return "not signed in — run the signin skill (all events dropped)";
  if (isLicenseTokenExpired(token)) {
    return "license expired — run the signin skill (all events dropped)";
  }
  const orgs = getAllowedGitHubOrgs();
  if (orgs.length === 0) return "signed in (no orgs cached) — all events dropped";
  return `events upload only from repos in: ${orgs.join(", ")}`;
}

function saveRepositoryChoice(value) {
  try {
    saveTelemetryOptIn(cwd, value);
    return true;
  } catch {
    process.stderr.write(`SkillMeter: Could not update ${SETTINGS_RELATIVE}; check its JSON and file permissions.\n`);
    process.exitCode = 1;
    return false;
  }
}

switch (action) {
  case "enable":
    if (isGlobal) {
      setTelemetryGloballyDisabled(false);
      process.stderr.write("SkillMeter: Global telemetry uploads enabled for this machine\n");
    } else {
      if (!saveRepositoryChoice(true)) break;
      process.stderr.write(`SkillMeter: Repository choice saved for ${projectRoot}\n`);
      process.stderr.write(`           (saved to ${SETTINGS_RELATIVE}; scope and global pause still apply)\n`);
      if (getTelemetryOptIn(cwd) !== true) {
        process.stderr.write("SkillMeter: A subdirectory setting still blocks capture here; review its telemetry setting.\n");
      }
      if (getTelemetryGloballyDisabled()) {
        process.stderr.write(
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
      process.stderr.write(`SkillMeter: New capture disabled for ${projectRoot}; previously queued data is not purged\n`);
    }
    break;
  case "status": {
    if (getTelemetryGloballyDisabled()) {
      process.stderr.write("SkillMeter: Global telemetry is disabled for this machine\n");
    } else {
      process.stderr.write("SkillMeter: Global telemetry is enabled for this machine\n");
    }
    const optIn = getTelemetryOptIn(cwd);
    if (optIn === true) {
      process.stderr.write(`SkillMeter: Telemetry is enabled for ${cwd}\n`);
    } else if (optIn === false) {
      process.stderr.write(`SkillMeter: Telemetry is disabled for ${cwd}\n`);
    } else {
      process.stderr.write(`SkillMeter: Telemetry is not configured for ${cwd}\n`);
    }
    process.stderr.write(`SkillMeter: Repo scope — ${repoScopeLine()}\n`);
    break;
  }
  default:
    process.stderr.write("Usage: node telemetry.js <enable|disable|status> [--global]\n");
    process.exit(1);
}

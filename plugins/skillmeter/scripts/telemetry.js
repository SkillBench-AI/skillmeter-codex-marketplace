#!/usr/bin/env node
/**
 * Toggle SkillMeter telemetry for the current Codex project.
 *
 * Usage:
 *   node telemetry.js enable
 *   node telemetry.js disable
 *   node telemetry.js enable --global
 *   node telemetry.js disable --global
 *   node telemetry.js status
 *
 * The per-project opt-in flag lives in
 * ${cwd}/.codex/settings.local.json under the `skillmeter` namespace.
 * The global kill-switch lives in ~/.skillbench/credentials.json so it applies
 * to every Codex project on the machine.
 */

const {
  getTelemetryOptIn,
  getTelemetryGloballyDisabled,
  saveTelemetryOptIn,
  setTelemetryGloballyDisabled,
  SETTINGS_RELATIVE,
} = require("./logger.js");
const {
  getAllowedGitHubOrgs,
  getLicenseToken,
  isLicenseTokenExpired,
  getSignedOut,
} = require("./credstore.js");

const cwd = process.cwd();
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

switch (action) {
  case "enable":
    if (isGlobal) {
      setTelemetryGloballyDisabled(false);
      process.stderr.write("SkillMeter: Global telemetry uploads enabled for this machine\n");
    } else {
      saveTelemetryOptIn(cwd, true);
      process.stderr.write(`SkillMeter: Telemetry enabled for ${cwd}\n`);
      process.stderr.write(`           (saved to ${SETTINGS_RELATIVE})\n`);
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
      saveTelemetryOptIn(cwd, false);
      process.stderr.write(`SkillMeter: Telemetry disabled for ${cwd}\n`);
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

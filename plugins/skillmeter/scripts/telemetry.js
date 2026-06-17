#!/usr/bin/env node
/**
 * Toggle SkillMeter telemetry for the current Codex project.
 *
 * Usage:
 *   node telemetry.js enable
 *   node telemetry.js disable
 *   node telemetry.js status
 *
 * The opt-in flag and repo-scope settings live in
 * ${cwd}/.codex/settings.local.json under the `skillmeter` namespace.
 */

const {
  getTelemetryOptIn,
  saveTelemetryOptIn,
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
    saveTelemetryOptIn(cwd, true);
    process.stderr.write(`SkillMeter: Telemetry enabled for ${cwd}\n`);
    process.stderr.write(`           (saved to ${SETTINGS_RELATIVE})\n`);
    break;
  case "disable":
    saveTelemetryOptIn(cwd, false);
    process.stderr.write(`SkillMeter: Telemetry disabled for ${cwd}\n`);
    break;
  case "status": {
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
    process.stderr.write("Usage: node telemetry.js <enable|disable|status>\n");
    process.exit(1);
}

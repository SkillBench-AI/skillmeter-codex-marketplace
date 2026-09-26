/**
 * Read skillmeter settings from <cwd>/.codex/settings.local.json.
 * Shared by authentication URL and client-ID resolution without importing logger.
 */

const fs = require("fs");
const path = require("path");

const SETTINGS_RELATIVE = path.join(".codex", "settings.local.json");

function readSettingsFile(cwd) {
  try {
    const p = path.join(cwd, SETTINGS_RELATIVE);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Read a string-valued field under `skillmeter.<key>` from the project's
 * settings file. Used by the activation-URL and GitHub-client-id resolvers to
 * support persistent per-user overrides without an env var.
 * @returns {string|null} Trimmed value when present and non-empty; null otherwise.
 */
function getSkillmeterStringSetting(cwd, key) {
  try {
    const content = readSettingsFile(cwd);
    if (!content || !content.skillmeter) return null;
    const v = content.skillmeter[key];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

// Missing consent is distinct from malformed or unreadable settings: a shared
// grant may replace an unset choice, but must never bypass a local restriction.
function readTelemetryChoice(directory) {
  const file = path.join(directory, SETTINGS_RELATIVE);
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  try {
    const settings = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!object(settings) || (settings.skillmeter !== undefined && !object(settings.skillmeter))) return "invalid";
    const choice = settings.skillmeter?.telemetry;
    return choice === true ? "on" : choice === false ? "off" : choice === undefined ? "unset" : "invalid";
  } catch (error) {
    const { policyPathIsAbsent } = require("./shared-telemetry-policy");
    return error.code === "ENOENT" && policyPathIsAbsent(file) ? "unset" : "invalid";
  }
}

module.exports = {
  SETTINGS_RELATIVE,
  readTelemetryChoice,
  readSettingsFile,
  getSkillmeterStringSetting,
};

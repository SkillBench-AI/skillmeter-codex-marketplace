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

module.exports = {
  SETTINGS_RELATIVE,
  readSettingsFile,
  getSkillmeterStringSetting,
};

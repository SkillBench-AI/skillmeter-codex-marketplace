"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Read Claude's canonical global pause without migrating repository choices or
// writing shared state. Daemons must observe changes made by another client.
function readSharedGlobalPolicy() {
  const stateDir = process.env.SKILLMETER_STATE_DIR ||
    path.join(os.homedir(), process.env.SKILLMETER_ENV === "dev" ? ".skillbench-dev" : ".skillbench");
  let raw;
  try {
    raw = fs.readFileSync(path.join(stateDir, "telemetry-policy.json"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { disabled: false, reason: "absent", boundary: null };
    return { disabled: true, reason: "invalid", boundary: "invalid" };
  }
  try {
    const policy = JSON.parse(raw);
    const global = policy?.global;
    if (policy?.schema_version !== 1 || typeof global?.enabled !== "boolean" ||
        (global.decided_at !== undefined && (!Number.isSafeInteger(global.decided_at) || global.decided_at < 0))) {
      throw new Error("invalid-global-policy");
    }
    return {
      disabled: !global.enabled,
      reason: global.enabled ? "enabled" : "paused",
      // Only a global decision closes a capture interval. Unrelated repository
      // revisions must not discard authorized transcript growth.
      boundary: JSON.stringify([global.enabled, global.decided_at ?? null]),
    };
  } catch {
    return { disabled: true, reason: "invalid", boundary: "invalid" };
  }
}

module.exports = { readSharedGlobalPolicy };

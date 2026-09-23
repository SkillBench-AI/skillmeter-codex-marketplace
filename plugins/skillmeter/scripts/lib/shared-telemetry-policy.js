"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Read Claude's canonical global pause without migrating repository choices or
// writing shared state. Daemons must observe changes made by another client.
function readSharedGlobalPolicy() {
  const stateDir = process.env.SKILLMETER_STATE_DIR ||
    path.join(os.homedir(), process.env.SKILLMETER_ENV === "dev" ? ".skillbench-dev" : ".skillbench");
  const file = path.join(stateDir, "telemetry-policy.json");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      try { fs.lstatSync(file); }
      catch (statError) {
        if (statError.code === "ENOENT") return { disabled: false, reason: "absent", boundary: null };
      }
    }
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
      policy,
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

// Canonical records are restrictive during migration: they never replace a
// required local opt-in. Unknown records hold delivery; explicit OFF revokes.
function readSharedRepositoryPolicy(scope) {
  const key = scope.repoKey;
  const shared = readSharedGlobalPolicy();
  if (shared.reason === "absent") return { key, allowed: true, reason: "absent", stamp: key ? JSON.stringify([key, null]) : null };
  if (!scope.allowed || !key) return { allowed: false, reason: "scope_unavailable", stamp: null };
  if (!shared.policy) return { allowed: false, reason: "invalid", stamp: null };
  const { organizations, repositories } = shared.policy;
  const object = value => value && typeof value === "object" && !Array.isArray(value);
  if (!object(organizations) || !object(repositories)) return { allowed: false, reason: "invalid", stamp: null };
  const organization = Object.hasOwn(organizations, scope.remoteOrg) ? organizations[scope.remoteOrg] : null;
  const repository = Object.hasOwn(repositories, key) ? repositories[key] : null;
  const valid = record => object(record) && typeof record.enabled === "boolean" &&
    (record.decided_at === undefined || (Number.isSafeInteger(record.decided_at) && record.decided_at >= 0));
  const revoked = (valid(organization) && !organization.enabled) || (valid(repository) && !repository.enabled);
  // Preserve a known OFF even when the other choice is absent or malformed.
  if (!revoked && (!valid(organization) || !valid(repository))) {
    return { allowed: false, reason: "shared_choice_required", stamp: null };
  }
  const recordStamp = record => valid(record) ? [record.enabled, record.decided_at ?? null] : null;
  return {
    key,
    allowed: !revoked,
    revoked,
    reason: revoked ? "shared_opt_out" : "enabled",
    stamp: JSON.stringify([key, recordStamp(organization), recordStamp(repository)]),
  };
}

module.exports = { readSharedGlobalPolicy, readSharedRepositoryPolicy };

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// ENOENT can mean a missing file or an unresolved link in any parent path.
function policyPathIsAbsent(file) {
  let current = file;
  while (true) {
    let entry;
    try { entry = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== "ENOENT") return false;
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
      continue;
    }
    try { if (entry.isSymbolicLink()) fs.statSync(current); }
    catch { return false; }
    return current !== file;
  }
}

function sharedPolicyFile() {
  const stateDir = process.env.SKILLMETER_STATE_DIR ||
    path.join(os.homedir(), process.env.SKILLMETER_ENV === "dev" ? ".skillbench-dev" : ".skillbench");
  return path.join(stateDir, "telemetry-policy.json");
}

// Unknown records hold delivery; explicit OFF revokes. Only acknowledged
// organization and repository grants can replace a required local opt-in.
function evaluateSharedRepositoryPolicy(scope, shared) {
  const key = scope.repoKey;
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
  // Preserve a known OFF even when the other choice is absent.
  if (!revoked && (!valid(organization) || !valid(repository))) {
    return { allowed: false, reason: "shared_choice_required", stamp: null };
  }
  const recordStamp = record => {
    if (!valid(record)) return null;
    // Keep the existing encoding for legacy queues. A scope acknowledgement
    // change adds a boundary without holding every unchanged legacy payload.
    const stamp = [record.enabled, record.decided_at ?? null];
    if (record.consent_version !== undefined) stamp.push(record.consent_version);
    return stamp;
  };
  return {
    key,
    allowed: !revoked,
    revoked,
    acknowledged: !revoked && organization?.consent_version === 2 && repository?.consent_version === 2,
    reason: revoked ? "shared_opt_out" : "enabled",
    stamp: JSON.stringify([key, recordStamp(organization), recordStamp(repository)]),
  };
}

module.exports = { evaluateSharedRepositoryPolicy, policyPathIsAbsent, sharedPolicyFile };

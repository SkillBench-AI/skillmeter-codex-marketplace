"use strict";
const { createSharedPolicyStore } = require("./shared-policy-store");
const { sharedPolicyFile, evaluateSharedRepositoryPolicy: evaluateRepository } = require("./shared-telemetry-policy");

// Runtime and controls use the same strict reader and durable client marker.
// No policy repair or default grant occurs on read.
function createSharedConsentReader(observedFile) {
  function readSharedGlobalPolicy() {
    try {
      const policy = createSharedPolicyStore({ file: sharedPolicyFile(), observedFile }).readPolicy();
      if (!policy) return { disabled: false, reason: "absent", boundary: null };
      return {
        policy, disabled: !policy.global.enabled,
        reason: policy.global.enabled ? "enabled" : "paused",
        boundary: JSON.stringify([policy.global.enabled, policy.global.decided_at ?? null]),
      };
    } catch (error) {
      return { disabled: true, reason: error.code === "POLICY_MISSING" ? "missing" : "invalid",
        errorCode: error.code, boundary: error.code || "invalid" };
    }
  }
  function readSharedRepositoryPolicy(scope) {
    const shared = readSharedGlobalPolicy();
    if (shared.reason === "missing") return { allowed: false, reason: "shared_policy_missing", stamp: null };
    return evaluateRepository(scope, shared);
  }
  return { readSharedGlobalPolicy, readSharedRepositoryPolicy };
}
module.exports = { createSharedConsentReader };

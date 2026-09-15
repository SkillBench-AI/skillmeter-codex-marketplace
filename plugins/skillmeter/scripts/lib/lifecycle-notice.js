"use strict";
const {readLicenseStatus} = require("./license-status");
const actions = {
  revoked:"License revoked. Ask your organization administrator, then sign in again.",
  identity_mismatch:"GitHub account or tenant changed. Sign in explicitly to confirm the intended identity.",
  gh_unauthenticated:"GitHub CLI authentication is unavailable. Sign in explicitly to recover delivery.",
  signin_required:"No prior sign-in can be recovered. Run the SkillMeter sign-in flow.",
  backoff_exhausted:"License recovery stopped after repeated failures. Check connectivity and start a new session or sign in again.",
};
function notice() {
  const status = readLicenseStatus();
  if (status.terminal) return actions[status.terminal.reason] || "License recovery stopped. Run the SkillMeter sign-in flow.";
  if (status.next_retry_at > Date.now()) return `License recovery will retry after ${new Date(status.next_retry_at).toISOString()}. Unsent payloads expire after seven days.`;
  return "License recovery has no pending failure. Unsent payloads expire after seven days.";
}
module.exports = {notice};

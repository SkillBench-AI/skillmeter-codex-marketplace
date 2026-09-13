// Shared policy location matches Claude; no activation or auth configuration
// is changed by this adapter. Overrides support isolated development/tests.
const os = require("node:os");
const path = require("node:path");
const STATE_DIR = process.env.SKILLMETER_STATE_DIR || path.join(os.homedir(), ".skillbench");
module.exports = {
  STATE_DIR,
  CRED_FILE: path.join(STATE_DIR, "credentials.json"),
  TELEMETRY_POLICY_FILE: path.join(STATE_DIR, "telemetry-policy.json"),
};

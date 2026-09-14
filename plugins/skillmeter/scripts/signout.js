#!/usr/bin/env node
/**
 * Sign the current machine out of SkillMeter:
 *   - Drop the license JWT and allowed-orgs list.
 *   - Disable uploads and retire unsent Codex telemetry, including legacy queues.
 *   - Set `signed_out: true` so the next SessionStart doesn't silently re-mint a
 *     license via a still-authenticated gh CLI.
 *   - Preserve `device_id` and `hash_salt` — the machine identity is persistent
 *     and is reused if the user signs back in.
 *
 * The sign-in flow clears the `signed_out` flag on success.
 *
 * Run directly:  node scripts/signout.js
 */

const credstore = require("./credstore.js");

function main() {
  const hadLicense = credstore.getLicenseToken() !== null;

  credstore.signOut();

  if (hadLicense) {
    process.stdout.write("SkillMeter: signed out; uploads disabled and unsent Codex telemetry removal requested.\n");
    process.stdout.write("SkillMeter: run the SkillMeter sign-in flow to re-enable uploads.\n");
  } else {
    process.stdout.write("SkillMeter: already signed out; global telemetry uploads disabled.\n");
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`Sign-out failed: ${err.message}\n`);
  process.exit(1);
}

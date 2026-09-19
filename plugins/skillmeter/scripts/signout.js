#!/usr/bin/env node
/**
 * Remove the shared license and allowed organizations, pause uploads and block
 * silent reactivation. Preserve device ID and hash salt for the next sign-in.
 * Usage: node scripts/signout.js.
 */

const credstore = require("./credstore.js");

function main() {
  const hadLicense = credstore.getLicenseToken() !== null;

  credstore.signOut();

  if (hadLicense) {
    process.stdout.write("SkillMeter: signed out and global telemetry uploads disabled.\n");
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

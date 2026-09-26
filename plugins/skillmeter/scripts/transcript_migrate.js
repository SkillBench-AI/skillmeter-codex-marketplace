#!/usr/bin/env node
"use strict";
// Explicit administrative command; never invoked by hooks or update/install scripts.
const fs = require("node:fs");
const path = require("node:path");
const logger = require("./logger");

function main(args) {
  if (args[0] === "prepare" && args.length === 3) {
    const plan = logger.migrateLegacyTranscript(path.resolve(args[1]), process.cwd());
    fs.writeFileSync(args[2], JSON.stringify({plan, authorizedRanges: null, evidence: null}, null, 2)+"\n", {flag:"wx",mode:0o600});
    return {status:"approval-required",committedOffset:plan.committedOffset,observed:plan.observed};
  }
  if (args[0] === "apply" && args.length === 2) {
    const approval = JSON.parse(fs.readFileSync(args[1], "utf8"));
    if (!approval.plan || typeof approval.plan.source !== "string") throw new Error("legacy-invalid-plan");
    return logger.migrateLegacyTranscript(approval.plan.source, process.cwd(), approval);
  }
  throw new Error("usage: transcript_migrate.js prepare SOURCE APPROVAL_FILE | apply APPROVAL_FILE");
}
if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
  catch (error) {
    // Avoid printing arbitrary JSON, source content, filesystem paths or tokens.
    const code = /^(legacy-[a-z-]+|invalid-legacy-migration)$/.test(error.message) ? error.message : "legacy-migration-failed";
    console.error(JSON.stringify({status:"blocked",code})); process.exitCode=1;
  }
}
module.exports = {main};

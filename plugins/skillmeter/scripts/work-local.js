#!/usr/bin/env node
"use strict";
// Candidate-only local consent/recovery command. Never installs hooks or uploads.
const {workCapture} = require("./lib/work-runtime");
async function main(args) {
  const capture=workCapture(), [command,source,sessionId]=args;
  let result;
  if (command==="enable" && args.length===3) result=capture.enable(source,sessionId);
  else if (command==="disable" && args.length===1) result=capture.disable();
  else if (command==="status" && args.length===1) result=capture.status();
  else if (command==="reconcile" && args.length===1) result=capture.reconcile();
  else throw Error("usage");
  process.stdout.write(JSON.stringify(result)+"\n");
}
if (require.main===module) main(process.argv.slice(2)).catch(error=>{
  const known=["work-auth-unavailable","unsupported-work-source","unsupported-session-originator","scope-mismatch","source-owner-changed"];
  console.error(known.includes(error.message)?error.message:"Work local capture unavailable. Usage: work-local.js enable <exact-transcript-path> <task-id> | reconcile | status | disable");
  process.exitCode=1;
});
module.exports={main};

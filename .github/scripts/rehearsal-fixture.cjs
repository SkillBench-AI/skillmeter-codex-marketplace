"use strict";
// This fixture is copied into a disposable repository only. Production workflows
// never call it and never accept a rehearsal scenario as a compatibility result.
const fs=require("node:fs");
const {revision}=require("./compatibility-contract.cjs");
const CASES=["good","failure","missing-evidence","changed-candidate","stale-evidence","cancelled","timeout"];
function fixture() {
  const marker=JSON.parse(fs.readFileSync("compatibility/rehearsal.json","utf8"));
  const scenario=process.env.GITHUB_EVENT_NAME==="workflow_dispatch" ? process.env.REHEARSAL_CASE : JSON.parse(fs.readFileSync("compatibility/rehearsal-case.json","utf8")).scenario;
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*-shipping-rehearsal$/.test(marker.repository) || marker.repository!==process.env.GITHUB_REPOSITORY || marker.syntheticOnly!==true || !CASES.includes(scenario) || !revision(process.env.GITHUB_SHA))throw Error("invalid-rehearsal-context");
  return scenario;
}
async function run(command) {
  const scenario=fixture();
  if(command==="guard")return;
  if(command!=="emit")throw Error("invalid-rehearsal-command");
  if(scenario==="failure")throw Error("deliberate-compatibility-failure");
  if(["cancelled","timeout"].includes(scenario)){
    // The workflow has a one-minute job deadline. Cancel the cancelled case
    // through GitHub before that deadline; the observer distinguishes the two.
    await new Promise(resolve=>setTimeout(resolve,90000));
    throw Error("expected-cancellation-or-timeout-did-not-occur");
  }
  const sha=scenario==="missing-evidence"?"":scenario==="changed-candidate"?"0".repeat(40):process.env.GITHUB_SHA;
  const at=scenario==="stale-evidence"?"2000-01-01T00:00:00Z":new Date().toISOString();
  fs.appendFileSync(process.env.GITHUB_OUTPUT,`verified_sha=${sha}\nverified_at=${at}\n`);
}
module.exports={CASES,fixture};
if(require.main===module)run(process.argv[2]).catch(error=>{console.error(/^[a-z-]+$/.test(error.message)?error.message:"rehearsal-fixture-failed");process.exitCode=1;});

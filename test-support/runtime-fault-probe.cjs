"use strict";
// The same oracle runs against pristine and faulted temporary runtime copies.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const zlib = require("node:zlib");
const [runtime, root, scenario] = process.argv.slice(2);
os.homedir = () => root;
process.env.PLUGIN_DATA = path.join(root, "data");
for (const name of ["node:http", "node:https", "node:net", "node:tls"]) {
  const mod = require(name);
  for (const key of ["request", "get", "connect", "createConnection"]) if (mod[key]) mod[key] = () => { throw Error("network-denied"); };
}
global.fetch = () => { throw Error("network-denied"); };
const cp = require("node:child_process");
for (const key of ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync"]) cp[key] = () => { throw Error("process-denied"); };
const emit = (status, reason) => process.stdout.write(JSON.stringify({status, reason}) + "\n");
(async () => {
  const queue = require(path.join(runtime, "plugins/skillmeter/scripts/lib/transcript-delta.js"));
  const source = path.join(root,"source.jsonl"), chunks = path.join(root,"queue");
  const scope = {owner:"fixture-owner",deviceId:"fixture-device",cwd:"/synthetic",repoRoot:"/synthetic",org:"synthetic",consentStamp:"fixture-grant"};
  const salt = "fixture-salt", stamp = "fixture-choice";
  const row = content => JSON.stringify({type:"response_item",payload:{type:"message",role:"user",content}}) + "\n";
  const stage = () => queue.stage(chunks,source,scope,salt,{consent:queue.observeConsent(chunks,source,scope,salt,true,stamp)});
  const messages = files => files.flatMap(file => zlib.gunzipSync(fs.readFileSync(file)).toString().trim().split("\n").map(JSON.parse)).map(row => row.payload?.content);
  if (scenario === "omitted-backlog") {
    fs.writeFileSync(source,row("acknowledged"));
    queue.stage(chunks,source,scope,salt); // Legacy v1 state without a journal.
    await queue.drainDirectory(queue.queueDirectories(chunks)[0],async()=>"sent");
    fs.appendFileSync(source,row("eligible-backlog"));
    const plan = queue.prepareLegacyMigration(chunks,source,scope,salt);
    queue.applyLegacyMigration(chunks,source,scope,salt,{plan,authorizedRanges:[[0,plan.observed]],evidence:"synthetic full-range approval",stamp,authorizeCommit:()=>true});
    fs.appendFileSync(source,row("new-work"));
    const observed = messages(stage().files);
    if (JSON.stringify(observed) === JSON.stringify(["eligible-backlog","new-work"])) emit("pass","preserved");
    else if (JSON.stringify(observed) === JSON.stringify(["new-work"])) emit("violation",scenario);
    else emit("error","unexpected-probe-result");
  } else if (scenario === "ignored-consent") {
    fs.writeFileSync(source,"");
    queue.observeConsent(chunks,source,scope,salt,true,stamp);
    fs.appendFileSync(source,row("allowed-before"));
    queue.observeConsent(chunks,source,scope,salt,true,stamp);
    queue.observeConsent(chunks,source,scope,salt,false,stamp);
    fs.appendFileSync(source,row("excluded-while-disabled"));
    queue.observeConsent(chunks,source,scope,salt,true,stamp);
    fs.appendFileSync(source,row("allowed-after"));
    const observed = messages(stage().files);
    if (JSON.stringify(observed) === JSON.stringify(["allowed-before","allowed-after"])) emit("pass","preserved");
    else if (JSON.stringify(observed) === JSON.stringify(["allowed-before","excluded-while-disabled","allowed-after"])) emit("violation",scenario);
    else emit("error","unexpected-probe-result");
  } else emit("error","unknown-scenario");
})().catch(() => { emit("error","probe-error"); process.exitCode=1; });

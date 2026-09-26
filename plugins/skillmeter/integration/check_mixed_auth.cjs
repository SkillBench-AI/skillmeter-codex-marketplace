"use strict";
// Explicit cross-client acceptance gate. A failed combination must not be released.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {spawnSync, execFileSync} = require("node:child_process");
const { load, digest } = require("../../../.github/scripts/compatibility-contract.cjs");
const contract = load(), startedAt = new Date().toISOString();
const claude = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.existsSync(path.join(claude,"skillmeter/scripts/credstore.js"))) throw Error("Usage: node check_mixed_auth.cjs /path/to/claude-checkout");
const candidate = path.resolve(__dirname,"..");
for (const cwd of [path.resolve(candidate,"../.."),claude]) {
  if (execFileSync("git",["status","--porcelain","--untracked-files=all"],{cwd,encoding:"utf8"}).trim()) throw Error("clean-checkout-required");
}
const revisions = Object.fromEntries([["codex",path.resolve(candidate,"../..")],["claude",claude]].map(([name,cwd]) => [name,execFileSync("git",["rev-parse","HEAD"],{cwd,encoding:"utf8"}).trim()]));
const results = [];
for (const scenario of contract.requiredCases.mixedAuth) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"mixed-auth-"));
  try {
    const processCase = scenario.startsWith("concurrent-") || scenario.startsWith("delayed-") || scenario.startsWith("aged-live-") || ["dead-owner-reaper-race", "aliased-dead-owner-reapers"].includes(scenario) ||
      ["interrupted-credential-writer", "surviving-codex-process"].includes(scenario);
    const script = processCase ? "auth-process-transition.cjs" : "auth-transition.cjs";
    const producers = scenario === "surviving-codex-process" ? contract.upgradePaths.map(release => {
      const checkout = path.join(root, release.version);
      fs.mkdirSync(checkout);
      const archive = execFileSync("git", ["archive", release.revision, "plugins/skillmeter"], {cwd:path.resolve(candidate,"../.."),maxBuffer:20*1024*1024});
      execFileSync("tar", ["-x", "-C", checkout], {input:archive});
      return path.join(checkout, "plugins/skillmeter");
    }) : [candidate];
    const passed = producers.map((producer, index) => {
      const state = path.join(root, "state-" + index);
      fs.mkdirSync(state);
      return spawnSync(process.execPath,[path.resolve(candidate,"../../test-support",script),state,path.join(claude,"skillmeter"),producer,scenario,"claude"],{encoding:"utf8",timeout:15000,env:{PATH:process.env.PATH,TMPDIR:os.tmpdir()}}).status === 0;
    });
    results.push({scenario,status:passed.every(Boolean)?"pass":"fail"});
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
for (const [name,cwd] of [["codex",path.resolve(candidate,"../..")],["claude",claude]]) {
  if (execFileSync("git",["status","--porcelain","--untracked-files=all"],{cwd,encoding:"utf8"}).trim() || execFileSync("git",["rev-parse","HEAD"],{cwd,encoding:"utf8"}).trim() !== revisions[name]) throw Error("candidate-changed-during-test");
}
process.stdout.write(JSON.stringify({version:1,kind:"mixed-client-authorization-gate",revisions,results,startedAt,finishedAt:new Date().toISOString(),contractSha256:digest(contract),limitations:["Synthetic interleavings and separate credential-writing processes; no native host lifecycle proof; lock safety requires both clients using the updated protocol.","No installed state, real credentials or network."]},null,2)+"\n");
process.exitCode = results.every(r=>r.status==="pass")?0:1;

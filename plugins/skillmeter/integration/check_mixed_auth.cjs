"use strict";
// Explicit cross-client acceptance gate. A failed combination must not be released.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {spawnSync, execFileSync} = require("node:child_process");
const claude = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.existsSync(path.join(claude,"skillmeter/scripts/credstore.js"))) throw Error("Usage: node check_mixed_auth.cjs /path/to/claude-checkout");
const candidate = path.resolve(__dirname,"..");
for (const cwd of [path.resolve(candidate,"../.."),claude]) {
  if (execFileSync("git",["status","--porcelain","--untracked-files=all"],{cwd,encoding:"utf8"}).trim()) throw Error("clean-checkout-required");
}
const revisions = Object.fromEntries([["codex",path.resolve(candidate,"../..")],["claude",claude]].map(([name,cwd]) => [name,execFileSync("git",["rev-parse","HEAD"],{cwd,encoding:"utf8"}).trim()]));
const results = [];
for (const scenario of ["signed-in","signed-out","expired","global-pause","repository-off","interrupted-refresh","auth-rejection"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"mixed-auth-"));
  try {
    const result = spawnSync(process.execPath,[path.resolve(candidate,"../../test-support/auth-transition.cjs"),root,path.join(claude,"skillmeter"),candidate,scenario,"claude"],{encoding:"utf8",timeout:15000,env:{PATH:process.env.PATH,TMPDIR:os.tmpdir()}});
    results.push({scenario,status:result.status===0?"pass":"fail"});
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
for (const [name,cwd] of [["codex",path.resolve(candidate,"../..")],["claude",claude]]) {
  if (execFileSync("git",["status","--porcelain","--untracked-files=all"],{cwd,encoding:"utf8"}).trim() || execFileSync("git",["rev-parse","HEAD"],{cwd,encoding:"utf8"}).trim() !== revisions[name]) throw Error("candidate-changed-during-test");
}
process.stdout.write(JSON.stringify({version:1,kind:"mixed-client-authorization-gate",revisions,results,limitations:["Synthetic sequential writers, no native hooks or concurrent credential races.","No installed state, real credentials or network."]},null,2)+"\n");
process.exitCode = results.every(r=>r.status==="pass")?0:1;

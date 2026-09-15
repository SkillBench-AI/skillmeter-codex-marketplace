"use strict";
const {test,after,beforeEach} = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), {spawnSync,execFileSync} = require("node:child_process");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"work-runtime-"));
process.env.SKILLMETER_STATE_DIR=path.join(root,"state");
process.env.PLUGIN_DATA=path.join(root,"data");
process.env.HOME=root;
process.env.USERPROFILE=root;
const creds=path.join(process.env.SKILLMETER_STATE_DIR,"credentials.json");
const source=path.join(root,"rollout.jsonl");
const {workCapture}=require("../scripts/lib/work-runtime");
const queue=require("../scripts/lib/transcript-delta"), retention=require("../scripts/lib/queue-retention");
const logger=require("../scripts/logger");
const line=r=>JSON.stringify(r)+"\n";
const token=extra=>"e30."+Buffer.from(JSON.stringify({exp:4102444800,github_id:123,aud:"https://synthetic.meter.skillbench.ai",...extra})).toString("base64url")+".fixture";
const save=extra=>fs.writeFileSync(creds,JSON.stringify({device_id:"SYNTHETIC",hash_salt:"synthetic-salt",license_jwt:token(extra)}));
const count=()=>queue.queueDirectories(path.join(process.env.PLUGIN_DATA,"logs/work-local-v1/chunks")).flatMap(queue.pendingFiles).length;
const input=()=>({session_id:"task",cwd:root,transcript_path:source});
const append=()=>fs.appendFileSync(source,line({type:"response_item",payload:{type:"message",role:"user",content:"synthetic approved"}}));
beforeEach(()=>{
  fs.rmSync(process.env.SKILLMETER_STATE_DIR,{recursive:true,force:true});
  fs.rmSync(process.env.PLUGIN_DATA,{recursive:true,force:true});
  fs.mkdirSync(process.env.SKILLMETER_STATE_DIR); save({org:{login:"synthetic"}});
  fs.writeFileSync(source,line({type:"session_meta",payload:{id:"task",cwd:root,source:"vscode",originator:"codex_work_desktop"}}));
});
after(()=>fs.rmSync(root,{recursive:true,force:true}));
test("actual Stop hook uses the Work queue and emits required JSON",()=>{
  workCapture().enable(source,"task"); append();
  const result=spawnSync(process.execPath,[path.resolve(__dirname,"../scripts/stop.js")],{input:JSON.stringify(input()),env:process.env,encoding:"utf8"});
  assert.equal(result.status,0); assert.deepEqual(JSON.parse(result.stdout),{});
  assert.match(result.stderr,/Work local: staged; delivery disabled/);
  assert.equal(count(),1);
  assert.deepEqual(logger.listPendingTranscripts(),[]);
  assert.equal(fs.existsSync(path.join(process.env.PLUGIN_DATA,"logs/repositories")),false);
});
test("Work inside an approved repository cannot use the production transcript sender",async()=>{
  const repo=path.join(root,"repo");
  fs.mkdirSync(repo,{recursive:true}); execFileSync("git",["init","--quiet",repo]);
  execFileSync("git",["-C",repo,"remote","add","origin","https://github.com/synthetic/work.git"]);
  fs.writeFileSync(source,line({type:"session_meta",payload:{id:"task",cwd:repo,source:"vscode",originator:"codex_work_desktop"}}));
  const policy=require("../scripts/lib/telemetry-store");
  policy.setOrganizationConsent("synthetic",true); policy.setRepositoryOverride("github.com/synthetic/work",true);
  assert.equal(logger.captureGate(repo).capture,true);
  const before=fs.readFileSync(creds);
  const original=global.fetch; global.fetch=()=>assert.fail("Work attempted network delivery");
  try {
    assert.equal(logger.stageTranscriptForUpload(source,{cwd:repo}),null);
    await logger.transferTranscript(source,"SYNTHETIC",undefined,{cwd:repo});
    assert.deepEqual(logger.listPendingTranscripts(),[]);
  } finally {global.fetch=original;}
  assert.deepEqual(fs.readFileSync(creds),before);
});
test("logout purges local Work bodies and does not revive consent on sign-in",()=>{
  const capture=workCapture(); capture.enable(source,"task"); append(); capture.capture(input());
  assert.ok(count()>0);
  require("../scripts/credstore").signOut();
  assert.equal(count(),0); save();
  assert.equal(workCapture().status().enabled,false);
  assert.equal(workCapture().reconcile().status,"not-enabled");
});
test("global OFF/ON between hooks requires fresh task consent",()=>{
  workCapture().enable(source,"task"); append();
  const policy=require("../scripts/lib/telemetry-store");
  policy.setGlobalEnabled(false); policy.setGlobalEnabled(true);
  assert.equal(workCapture().capture(input()).status,"revoked");
  assert.equal(count(),0);
});
test("expired or tenant-less credentials cannot register Work",()=>{
  for(const extra of [{exp:1},{aud:undefined},{github_id:undefined}]) {
    save(extra); assert.throws(()=>workCapture().enable(source,"task"),/work-auth-unavailable/);
  }
});
test("expiry preserves the grant and queue across a restarted hook and same-user renewal",()=>{
  const capture=workCapture();capture.enable(source,"task");append();capture.reconcile();
  const expiresAt=capture.status().expiresAt;
  const pending=()=>queue.queueDirectories(path.join(process.env.PLUGIN_DATA,"logs/work-local-v1/chunks")).flatMap(queue.pendingFiles);
  const before=pending().map(file=>[file,fs.readFileSync(file)]);
  save({exp:1});
  fs.appendFileSync(source,line({type:"response_item",payload:{type:"message",role:"user",content:"recorded while expired"}}));
  const result=spawnSync(process.execPath,[path.resolve(__dirname,"../scripts/stop.js")],{input:JSON.stringify(input()),env:process.env,encoding:"utf8"});
  assert.equal(result.status,0);assert.match(result.stderr,/Work local: staged/);
  assert.ok(pending().length>before.length);
  for(const [file,bytes] of before) assert.ok(fs.readFileSync(file).equals(bytes),"expiry must retain existing chunks");
  assert.equal(workCapture().status().enabled,true);
  assert.equal(workCapture().status().tokenExpired,true);
  assert.throws(()=>workCapture().enable(source,"task"),/work-auth-unavailable/);
  save({exp:4102444900});
  assert.equal(workCapture().reconcile().status,"unchanged");
  assert.equal(workCapture().status().expiresAt,expiresAt,"renewal cannot extend task consent");
  assert.equal(workCapture().status().tokenExpired,false);
  const body=pending().map(file=>require("node:zlib").gunzipSync(fs.readFileSync(file)).toString()).join("");
  assert.equal(body.split("recorded while expired").length-1,1);
  assert.deepEqual(logger.listPendingTranscripts(),[]);
});
test("expired credentials do not bypass a changed user, tenant or device",()=>{
  for(const change of [{license_jwt:token({exp:1,github_id:456})},{license_jwt:token({exp:1,aud:"https://other.meter.skillbench.ai"})},{license_jwt:token({exp:1}),device_id:"OTHER"}]) {
    save();workCapture().enable(source,"task");append();workCapture().reconcile();
    const current=JSON.parse(fs.readFileSync(creds));fs.writeFileSync(creds,JSON.stringify({...current,...change}));
    assert.equal(workCapture().reconcile().status,"revoked");assert.equal(count(),0);
  }
});
test("malformed expiry claims remain unusable instead of becoming expired capture identities",()=>{
  for(const exp of [undefined,null,"expired"]) {
    save();workCapture().enable(source,"task");append();workCapture().reconcile();
    save({exp});assert.equal(workCapture().reconcile().status,"revoked");assert.equal(count(),0);
  }
});
test("terminal purge still revokes Work while a token is expired",()=>{
  workCapture().enable(source,"task");append();workCapture().reconcile();save({exp:1});
  retention.purgeAll();assert.equal(retention.enforcePending(),true);assert.equal(count(),0);
  save();assert.equal(workCapture().reconcile().status,"not-enabled");
});
test("Work status and enable never initialize missing shared identity fields",()=>{
  for (const missing of ["device_id","hash_salt"]) {
    save();
    const store=JSON.parse(fs.readFileSync(creds)); delete store[missing];
    fs.writeFileSync(creds,JSON.stringify(store));
    const before=fs.readFileSync(creds);
    assert.equal(workCapture().status().enabled,false);
    assert.ok(fs.readFileSync(creds).equals(before),"status must not initialize credentials");
    assert.throws(()=>workCapture().enable(source,"task"),/work-auth-unavailable/);
    assert.ok(fs.readFileSync(creds).equals(before),"enable must not initialize credentials");
    assert.equal(count(),0);
  }
});
test("shared seven-day retention retires Work bodies without replaying retired text",()=>{
  const capture=workCapture(); capture.enable(source,"task"); append(); capture.capture(input());
  const dirs=queue.queueDirectories(path.join(process.env.PLUGIN_DATA,"logs/work-local-v1/chunks"));
  assert.equal(retention.retireDirectory(dirs[0],false,Date.now()+8*86400000),true);
  assert.equal(count(),0);
  capture.reconcile();
  const zlib=require("node:zlib");
  const raw=dirs.flatMap(queue.pendingFiles).map(f=>zlib.gunzipSync(fs.readFileSync(f)).toString()).join("");
  assert.ok(!raw.includes("synthetic approved"));
});

"use strict";
const {test} = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), zlib = require("node:zlib");
const queue = require("../scripts/lib/transcript-delta");
const {createWorkCapture} = require("../scripts/lib/work-local");
const line = r => JSON.stringify(r) + "\n";
const message = text => ({type:"response_item",payload:{type:"message",role:"user",content:text}});
function setup(t, metadata = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"work-local-"));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const source = path.join(root,"rollout.jsonl"), state = path.join(root,"state");
  const header = {type:"session_meta",payload:{id:"selected-task",cwd:"/synthetic/non-repo",source:"vscode",originator:"codex_work_desktop",instructions:"EXCLUDED-INSTRUCTIONS",...metadata}};
  fs.writeFileSync(source,line(header)+line(message("EXCLUDED-HISTORY")));
  let identity = {owner:"synthetic-owner",deviceId:"SYNTHETIC",salt:"synthetic-salt"}, now = Date.now();
  const open = () => createWorkCapture({root:state,identity:() => identity,now:() => now});
  const adapter = open(), input = {session_id:"selected-task",transcript_path:source,cwd:"/synthetic/non-repo"};
  const append = r => fs.appendFileSync(source,line(r));
  const records = () => queue.queueDirectories(path.join(state,"chunks")).flatMap(queue.pendingFiles).flatMap(f=>zlib.gunzipSync(fs.readFileSync(f)).toString().trim().split("\n").map(JSON.parse));
  return {adapter,open,source,state,input,append,records,header,setIdentity:x=>{identity=x;},advance:ms=>{now+=ms;}};
}
test("selected non-Git Work task requires explicit consent and excludes startup history",t=>{
  const f=setup(t);
  assert.equal(f.adapter.capture(f.input).status,"not-enabled");
  assert.equal(f.adapter.enable(f.source,"selected-task").status,"enabled-local-only");
  f.append(message("approved text"));
  assert.equal(f.adapter.capture(f.input).status,"staged");
  const records=f.records();
  assert.equal(records[0].payload.originator,"codex_work_desktop");
  assert.equal(records[0].payload.id,"selected-task");
  assert.ok(!JSON.stringify(records).includes("EXCLUDED-"));
  assert.ok(!JSON.stringify(records).includes("/synthetic/non-repo"));
  assert.equal(f.adapter.status().delivery,"disabled");
});
test("delayed prompt and tool output reconcile on Stop and after restart exactly once",t=>{
  const f=setup(t); f.adapter.enable(f.source,"selected-task");
  f.adapter.capture({...f.input,hook_event_name:"UserPromptSubmit"});
  f.append(message("later persisted prompt"));
  f.append({type:"response_item",payload:{type:"custom_tool_call",call_id:"outer-1",name:"exec",input:"SECRET-COMMAND-CONTENT"}});
  f.adapter.capture({...f.input,hook_event_name:"PostToolUse"});
  const result={type:"response_item",payload:{type:"custom_tool_call_output",call_id:"outer-1",output:"synthetic result"}};
  const bytes=line(result); fs.appendFileSync(f.source,bytes.slice(0,-4));
  const partial=f.adapter.capture(f.input); // incomplete final line is never consumed
  assert.equal(partial.partial,true); assert.ok(partial.pendingBytes>0);
  fs.appendFileSync(f.source,bytes.slice(-4));
  f.open().capture({...f.input,hook_event_name:"Stop"});
  assert.equal(f.open().capture(f.input).status,"unchanged");
  const records=f.records();
  assert.equal(records.filter(r=>r.payload?.call_id==="outer-1").length,2);
  assert.equal(records.filter(r=>r.payload?.content==="later persisted prompt").length,1);
  assert.ok(!JSON.stringify(records).includes("SECRET-COMMAND-CONTENT"));
});
test("wrong task, path or cwd cannot capture or broaden an active grant",t=>{
  const f=setup(t); f.adapter.enable(f.source,"selected-task"); f.append(message("approved"));
  for(const override of [{session_id:"other"},{transcript_path:path.join(f.state,"other.jsonl")},{cwd:"/other"}]) {
    assert.equal(f.adapter.capture({...f.input,...override}).status,"scope-mismatch");
  }
  assert.equal(f.records().length,0);
  assert.equal(f.adapter.capture({session_id:"selected-task",cwd:f.input.cwd}).status,"staged");
});
test("ordinary Codex and unknown originators are not eligible for Work consent",t=>{
  for(const originator of ["codex_cli_rs","future_work",null,{}]) {
    const f=setup(t,{originator});
    assert.throws(()=>f.adapter.enable(f.source,"selected-task"),/unsupported-work-source|unsupported-session-originator/);
  }
});
test("source task mismatch and subagent registration are rejected",t=>{
  const f=setup(t); assert.throws(()=>f.adapter.enable(f.source,"other"),/scope-mismatch/);
  const child=setup(t,{parent_thread_id:"parent"});
  assert.throws(()=>child.adapter.enable(child.source,"selected-task"),/unsupported-work-source|unsupported-session-originator/);
});
test("revocation purges bodies and re-enabling excludes the paused tail",t=>{
  const f=setup(t); f.adapter.enable(f.source,"selected-task"); f.append(message("before disable")); f.adapter.capture(f.input);
  assert.equal(f.adapter.disable().status,"disabled"); assert.equal(f.records().length,0);
  f.append(message("EXCLUDED-OFF")); f.adapter.enable(f.source,"selected-task");
  f.append(message("after re-enable")); f.adapter.capture(f.input);
  assert.ok(!JSON.stringify(f.records()).includes("EXCLUDED-"));
  assert.ok(!JSON.stringify(f.records()).includes("before disable"));
});
test("account switch, unavailable authentication and expiry revoke the selected grant",t=>{
  for(const reason of ["account","signed-out","expiry"]) {
    const f=setup(t); f.adapter.enable(f.source,"selected-task"); f.append(message("approved")); f.adapter.capture(f.input);
    if(reason==="expiry") f.advance(86400001);
    else f.setIdentity(reason==="account"?{owner:"other",deviceId:"SYNTHETIC",salt:"synthetic-salt"}:null);
    assert.equal(f.adapter.capture(f.input).status,"revoked"); assert.equal(f.records().length,0);
    assert.equal(f.adapter.status().enabled,false);
  }
});
test("source replacement or metadata change requires fresh consent",t=>{
  for(const replacement of [false,true]) {
    const f=setup(t); f.adapter.enable(f.source,"selected-task"); f.append(message("approved")); f.adapter.capture(f.input);
    if(replacement) { fs.renameSync(f.source,f.source+".old"); fs.writeFileSync(f.source,line(f.header)); }
    else fs.writeFileSync(f.source,line({...f.header,payload:{...f.header.payload,id:"other"}}));
    assert.equal(f.adapter.capture(f.input).status,"revoked"); assert.equal(f.records().length,0);
  }
});
test("malformed complete records are explicit errors without publishing content",t=>{
  const f=setup(t); f.adapter.enable(f.source,"selected-task");
  fs.appendFileSync(f.source,"{not-json}\n");
  assert.equal(f.adapter.capture(f.input).status,"malformed-complete-record");
  assert.equal(f.records().length,0);
});
test("identity revoked during staging cannot publish a sanitized chunk",t=>{
  const f=setup(t); f.adapter.enable(f.source,"selected-task"); f.append(message("approved"));
  let checks=0;
  const capture=createWorkCapture({root:f.state,identity:()=>++checks===1?{owner:"synthetic-owner",deviceId:"SYNTHETIC",salt:"synthetic-salt"}:null});
  assert.equal(capture.capture(f.input).status,"consent-changed-during-stage");
  assert.equal(f.records().length,0);
});
test("busy purge remains denied and explicit reconciliation completes deletion",t=>{
  const f=setup(t); f.adapter.enable(f.source,"selected-task"); f.append(message("approved")); f.adapter.capture(f.input);
  const dir=queue.queueDirectories(path.join(f.state,"chunks"))[0];
  const release=queue.acquireLock(path.join(dir,"lock"));
  try {assert.equal(f.adapter.disable().status,"purge-pending"); assert.equal(f.adapter.status().enabled,false);}
  finally {release();}
  f.adapter.reconcile(); assert.equal(f.records().length,0); assert.equal(f.adapter.status().purgePending,false);
});
test("invalid local selection never becomes a payload deletion path",t=>{
  const f=setup(t); f.adapter.enable(f.source,"selected-task");
  const policy=path.join(f.state,"selected.json"), selected=JSON.parse(fs.readFileSync(policy));
  fs.writeFileSync(policy,JSON.stringify({...selected,queueId:"../../outside"}));
  assert.throws(()=>f.adapter.disable(),/invalid-work-selection/);
  assert.ok(fs.existsSync(f.source));
});

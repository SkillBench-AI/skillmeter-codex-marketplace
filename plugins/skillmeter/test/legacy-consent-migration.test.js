"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), zlib = require("node:zlib");
const q = require("../scripts/lib/transcript-delta");
const scope = {owner:"fixture",deviceId:"fixture",repoRoot:"/synthetic",cwd:"/synthetic",org:"synthetic",consentStamp:"approved"};
const salt = "fixture", stamp = "unchanged-settings";
const row = text => JSON.stringify({type:"response_item",payload:{type:"message",role:"user",content:text}})+"\n";
const meta = JSON.stringify({type:"session_meta",payload:{id:"migration-fixture",cwd:"/synthetic",originator:"codex_cli_rs"}})+"\n";
const records = files => files.flatMap(f=>zlib.gunzipSync(fs.readFileSync(f)).toString().trim().split("\n").map(JSON.parse));
const content = files => records(files).filter(r=>r.type==="response_item").map(r=>r.payload.content);
async function fixture(t, pending=false) {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"legacy-migration-"));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const source=path.join(temp,"source.jsonl"), root=path.join(temp,"queue");
  fs.writeFileSync(source,meta+row("acknowledged prefix"));
  // options omitted reproduces the legacy v1 cursor: no consent epoch/metadataVersion.
  const legacy=q.stage(root,source,scope,salt), dir=q.queueDirectories(root)[0];
  if(!pending) await q.drainDirectory(dir,async()=>"sent");
  fs.appendFileSync(source,row("eligible backlog"));
  const prepare=()=>q.prepareLegacyMigration(root,source,scope,salt);
  const apply=(plan, extra={})=>q.applyLegacyMigration(root,source,scope,salt,{plan,authorizedRanges:[[0,plan.observed]],evidence:"synthetic explicit approval",stamp,authorizeCommit:()=>true,...extra});
  const observe=()=>q.observeConsent(root,source,scope,salt,true,stamp);
  const stage=()=>q.stage(root,source,scope,salt,{consent:observe(),preserveSessionMetadata:true});
  return {source,root,dir,legacy,prepare,apply,observe,stage};
}

test("unmigrated legacy observation holds without changing cursor or pending chunks",async t=>{
  const f=await fixture(t,true), before=fs.readFileSync(path.join(f.dir,"cursor.json"));
  assert.throws(f.observe,/legacy-consent-migration-required/);
  assert.deepEqual(fs.readFileSync(path.join(f.dir,"cursor.json")),before);
  assert.equal(fs.existsSync(path.join(f.dir,"consent.json")),false);
  assert.equal(q.pendingFiles(f.dir).length,1);
  assert.throws(f.prepare,/legacy-pending-chunks/);
});

test("migration preserves generation, sequences and backlog, including reset/retry",async t=>{
  const f=await fixture(t),plan=f.prepare(),raw=fs.readFileSync(f.source);
  assert.equal(f.apply(plan).status,"migrated");
  assert.equal(f.apply(plan).status,"already-migrated");
  const staged=f.stage();
  assert.deepEqual(content(staged.files),["eligible backlog"]);
  assert.equal(staged.cursor.generation,f.legacy.cursor.generation);
  assert.equal(staged.cursor.baseline,f.legacy.cursor.baseline);
  assert.equal(staged.cursor.seq,f.legacy.cursor.seq+1);
  assert.equal(records(staged.files)[0].type,"session_continuation");
  await q.drainDirectory(f.dir,async()=>"reset-required");
  const reset=f.stage();
  assert.deepEqual(content(reset.files),["acknowledged prefix","eligible backlog"]);
  assert.deepEqual(fs.readFileSync(f.source),raw);
  const retry=q.pendingFiles(f.dir).map(f=>fs.readFileSync(f));
  await q.drainDirectory(f.dir,async()=>"retry");
  assert.deepEqual(q.pendingFiles(f.dir).map(f=>fs.readFileSync(f)),retry);
});

test("approved suffix excludes uncertain old content and blocks destructive reset",async t=>{
  const f=await fixture(t),plan=f.prepare();
  f.apply(plan,{authorizedRanges:[[plan.committedOffset,plan.observed]]});
  assert.deepEqual(content(f.stage().files),["eligible backlog"]);
  await q.drainDirectory(f.dir,async()=>"reset-required");
  assert.throws(f.stage,/legacy-reset-recovery-required/);
});

for(const point of ["after-receipt","after-cursor"]) test(`crash recovery at ${point} completes once and preserves later progress`,async t=>{
  const f=await fixture(t),plan=f.prepare();
  assert.throws(()=>f.apply(plan,{fault:where=>{if(where===point)throw Error("synthetic crash");}}),/synthetic crash/);
  assert.equal(f.apply(plan).status,"already-migrated");
  f.stage();
  const before=fs.readFileSync(path.join(f.dir,"cursor.json"));
  q.recover(f.dir);
  assert.deepEqual(fs.readFileSync(path.join(f.dir,"cursor.json")),before);
});

test("stale source, changed cursor and missing authorization fail without journal",async t=>{
  const f=await fixture(t),plan=f.prepare();
  assert.throws(()=>f.apply(plan,{evidence:""}),/legacy-authorization-required/);
  assert.throws(()=>f.apply(plan,{authorizeCommit:()=>false}),/legacy-authorization-required/);
  fs.appendFileSync(f.source,row("arrived after planning"));
  assert.throws(()=>f.apply(plan),/legacy-stale-plan/);
  assert.equal(fs.existsSync(path.join(f.dir,"consent.json")),false);
});

test("rewrite, wrong owner, non-boundary range, overlap and revocation fail closed",async t=>{
  const f=await fixture(t),plan=f.prepare();
  assert.throws(()=>q.prepareLegacyMigration(f.root,f.source,{...scope,owner:"other"},salt),/legacy-scope-mismatch/);
  assert.throws(()=>f.apply(plan,{authorizedRanges:[[1,plan.observed]]}),/legacy-incomplete-line/);
  assert.throws(()=>f.apply(plan,{authorizedRanges:[[0,plan.observed],[0,plan.observed]]}),/legacy-invalid-ranges/);
  let n=0;assert.throws(()=>f.apply(plan,{authorizeCommit:()=>++n===1}),/legacy-authorization-changed/);
  fs.writeFileSync(f.source,fs.readFileSync(f.source,"utf8").replace("acknowledged","unauthorized"));
  assert.throws(()=>f.apply(plan),/legacy-source-changed/);
  assert.equal(fs.existsSync(path.join(f.dir,"consent.json")),false);
});

test("pending legacy data can drain unchanged before explicit migration",async t=>{
  const f=await fixture(t,true),expected=fs.readFileSync(f.legacy.files[0]);
  const sent=[]; await q.drainDirectory(f.dir,async(_,body)=>{sent.push(body);return "sent";});
  assert.deepEqual(sent,[expected]);
  f.apply(f.prepare());
  assert.deepEqual(content(f.stage().files),["eligible backlog"]);
});

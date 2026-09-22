"use strict";
// Synthetic isolated staging only. No logger, credentials, hooks or sender.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const queue = require("../scripts/lib/transcript-delta");
const fixture = fs.readFileSync(path.join(__dirname,"fixtures/work/session.jsonl"),"utf8").trim().split("\n");
const scope = {owner:"synthetic-owner",deviceId:"SYNTHETIC",cwd:"/synthetic/agenda"};

test("Work identity and opaque outer tool pairs survive isolated staging and process restart", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"work-capture-fixture-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source = path.join(root,"source.jsonl"), chunks = path.join(root,"isolated-chunks");
  const first = fixture.slice(0,5).join("\n") + "\n";
  fs.writeFileSync(source,first);
  const staged = queue.stage(chunks,source,scope,"synthetic-salt");
  assert.equal(staged.status,"staged");
  fs.appendFileSync(source,fixture.slice(5).join("\n") + "\n");
  // A new process recovers the committed cursor without any retained JS state.
  const resumed = spawnSync(process.execPath,["-e",`
    const queue=require(process.argv[1]);
    queue.stage(process.argv[2],process.argv[3],JSON.parse(process.argv[4]),"synthetic-salt");
  `, require.resolve("../scripts/lib/transcript-delta"),chunks,source,JSON.stringify(scope)],{encoding:"utf8"});
  assert.equal(resumed.status,0,resumed.stderr);
  const [dir] = queue.queueDirectories(chunks);
  const files = queue.pendingFiles(dir);
  assert.deepEqual(files.map(file=>queue.metadata(file).seq),[1,2]);
  const records = files.flatMap(file=>zlib.gunzipSync(fs.readFileSync(file)).toString().trim().split("\n").map(JSON.parse));
  assert.equal(records.length,9);
  assert.equal(new Set(records.map(record=>record.uuid)).size,9);
  assert.equal(records[0].payload.id,"synthetic-work");
  assert.equal(records[0].payload.originator,"codex_work_desktop");
  assert.equal(records[0].payload.source,"vscode");
  assert.equal(records[0].payload.contact,"[EMAIL]");
  assert.deepEqual(records.filter(record=>record.payload.type==="message").map(record=>record.payload.content),[
    "Add the 10, 20 and 30 minute agenda items.","The total is 60 minutes.",
    "Remove the 30 minute item.","The revised total is 30 minutes.",
  ]);
  assert.ok(!JSON.stringify(records).includes("alice@example.com"));
  const calls = records.filter(record=>record.payload.type==="custom_tool_call");
  const results = records.filter(record=>record.payload.type==="custom_tool_call_output");
  assert.deepEqual(calls.map(record=>[record.payload.name,record.payload.call_id]),[["exec","outer-1"],["exec","outer-2"]]);
  assert.deepEqual(results.map(record=>[record.payload.call_id,record.payload.output]),[["outer-1","60 minutes"],["outer-2","30 minutes"]]);
  for (const call of calls) assert.ok(!call.payload.input.includes("return"),"opaque code stays opaque");
  assert.equal(queue.stage(chunks,source,scope,"synthetic-salt").status,"unchanged");
  assert.equal(fs.readFileSync(source,"utf8"),fixture.join("\n")+"\n");
});

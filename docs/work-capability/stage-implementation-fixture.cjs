"use strict";
// Synthetic-only bridge: exercise the actual local queue before Python parsing.
const fs=require("node:fs"), os=require("node:os"), path=require("node:path"), zlib=require("node:zlib");
const {createWorkCapture}=require("../../plugins/skillmeter/scripts/lib/work-local");
const queue=require("../../plugins/skillmeter/scripts/lib/transcript-delta");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"work-bridge-"));
try {
  const source=path.join(root,"rollout.jsonl"), state=path.join(root,"local");
  const line=r=>JSON.stringify(r)+"\n";
  const records=fs.readFileSync(path.join(__dirname,"fixture/local-work-runtime.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
  fs.writeFileSync(source,line(records[0])+line({type:"response_item",payload:{type:"message",role:"user",content:"EXCLUDED-HISTORY"}}));
  const open=()=>createWorkCapture({root:state,identity:()=>({owner:"synthetic-owner",deviceId:"SYNTHETIC",salt:"synthetic-salt"})});
  const capture=open();
  capture.enable(source,"synthetic-work-task");
  // Split the tool call/result across a prefix-preserving file replacement.
  const split=records.findIndex(r=>r.payload?.type==="custom_tool_call_output");
  if(split<1) throw Error("fixture missing tool result");
  fs.appendFileSync(source,records.slice(1,split).map(line).join(""));
  if(capture.reconcile().status!=="staged") throw Error("first stage failed");
  fs.copyFileSync(source,source+".replacement");
  fs.renameSync(source+".replacement",source);
  fs.appendFileSync(source,records.slice(split).map(line).join(""));
  if(open().reconcile().status!=="staged") throw Error("resume stage failed");
  for(const f of queue.queueDirectories(path.join(state,"chunks")).flatMap(queue.pendingFiles)) process.stdout.write(zlib.gunzipSync(fs.readFileSync(f)));
} finally {fs.rmSync(root,{recursive:true,force:true});}

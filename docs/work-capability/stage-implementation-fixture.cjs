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
  const capture=createWorkCapture({root:state,identity:()=>({owner:"synthetic-owner",deviceId:"SYNTHETIC",salt:"synthetic-salt"})});
  capture.enable(source,"synthetic-work-task");
  fs.appendFileSync(source,records.slice(1).map(line).join(""));
  capture.reconcile();
  for(const f of queue.queueDirectories(path.join(state,"chunks")).flatMap(queue.pendingFiles)) process.stdout.write(zlib.gunzipSync(fs.readFileSync(f)));
} finally {fs.rmSync(root,{recursive:true,force:true});}

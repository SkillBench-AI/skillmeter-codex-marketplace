"use strict";
// Production-readiness acceptance probes. Synthetic state only. Known gaps
// intentionally return exit 1; these are outside the default regression suite.
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {spawnSync}=require("node:child_process");
const mode=process.argv[2];
if (!mode) {
  const results=["expiry-retains-consented-queue","status-does-not-initialize-credentials"].map(name=>{
    const r=spawnSync(process.execPath,["--require",path.join(__dirname,"canary/network-guard.cjs"),__filename,name],{encoding:"utf8",timeout:10000});
    if(r.status!==0) return {name,outcome:"error"};
    try{return {name,...JSON.parse(r.stdout)};}catch{return {name,outcome:"error"};}
  });
  console.log(JSON.stringify({evidence:"synthetic-only",results},null,2));
  process.exitCode=results.every(r=>r.outcome==="pass")?0:1;
} else {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"work-review-"));
  process.env.SKILLMETER_STATE_DIR=path.join(root,"state");
  process.env.PLUGIN_DATA=path.join(root,"data");
  fs.mkdirSync(process.env.SKILLMETER_STATE_DIR);
  try {
    const credentials=path.join(process.env.SKILLMETER_STATE_DIR,"credentials.json");
    const jwt=exp=>"e30."+Buffer.from(JSON.stringify({exp,github_id:123,aud:"https://synthetic.meter.skillbench.ai"})).toString("base64url")+".fixture";
    const full={device_id:"SYNTHETIC",hash_salt:"synthetic",license_jwt:jwt(4102444800)};
    fs.writeFileSync(credentials,JSON.stringify(mode==="status-does-not-initialize-credentials"?{license_jwt:full.license_jwt}:full));
    const plugin=path.resolve(__dirname,"../../plugins/skillmeter");
    const capture=require(path.join(plugin,"scripts/lib/work-runtime")).workCapture();
    if(mode==="status-does-not-initialize-credentials") {
      const before=fs.readFileSync(credentials); capture.status();
      const unchanged=before.equals(fs.readFileSync(credentials));
      console.log(JSON.stringify({outcome:unchanged?"pass":"gap",credentialsUnchanged:unchanged}));
    } else if(mode==="expiry-retains-consented-queue") {
      const source=path.join(root,"rollout.jsonl"),line=r=>JSON.stringify(r)+"\n";
      fs.writeFileSync(source,line({type:"session_meta",payload:{id:"synthetic",cwd:root,source:"vscode",originator:"codex_work_desktop"}}));
      capture.enable(source,"synthetic");
      fs.appendFileSync(source,line({type:"response_item",payload:{type:"message",role:"user",content:"Synthetic consented message"}}));
      capture.reconcile();
      const queue=require(path.join(plugin,"scripts/lib/transcript-delta"));
      const count=()=>queue.queueDirectories(path.join(process.env.PLUGIN_DATA,"logs/work-local-v1/chunks")).flatMap(queue.pendingFiles).length;
      const before=count();if(!before)throw Error("fixture did not stage");
      fs.writeFileSync(credentials,JSON.stringify({...full,license_jwt:jwt(1)}));
      const result=capture.reconcile(),after=count();
      console.log(JSON.stringify({outcome:after>=before&&result.status!=="revoked"?"pass":"gap",beforeChunks:before,afterChunks:after,status:result.status}));
    } else throw Error("unknown probe");
  } finally {fs.rmSync(root,{recursive:true,force:true});}
}

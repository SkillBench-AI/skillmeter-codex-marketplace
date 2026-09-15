"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {spawnSync}=require("node:child_process");
const {run}=require("./native-hook.cjs");
const source=path.resolve(__dirname,"../../../plugins/skillmeter");
function fixture(fn){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"native-work-")));
 try{
  const c={expiresAt:Date.now()+60000,selected:"synthetic",cwd:root,transcript:path.join(root,"rollout.jsonl"),pluginData:path.join(root,"data"),stateDir:path.join(root,"state"),evidence:path.join(root,"evidence.jsonl")};
  fs.mkdirSync(c.stateDir);fs.cpSync(source,path.join(root,"candidate"),{recursive:true});fs.copyFileSync(path.resolve(__dirname,"../canary/network-guard.cjs"),path.join(root,"network-guard.cjs"));
  fs.writeFileSync(c.transcript,JSON.stringify({type:"session_meta",payload:{id:"synthetic",cwd:root,source:"vscode",originator:"codex_work_desktop"}})+"\n");
  const config=path.join(root,"config.json");fs.writeFileSync(config,JSON.stringify(c));
  fn({root,c,config,input:{session_id:c.selected,cwd:c.cwd,transcript_path:c.transcript}});
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
test("unselected and expired configuration cannot inspect a transcript",()=>fixture(({c,config,input,root})=>{
 fs.unlinkSync(c.transcript);
 for(const change of [{selected:null},{expiresAt:0}]){fs.writeFileSync(config,JSON.stringify({...c,...change}));assert.ok(["unselected","expired"].includes(run(config,"Stop",input,root).status));}
 assert.equal(fs.existsSync(c.evidence),false);
}));
test("other task, cwd, source and unknown event cannot capture",()=>fixture(({c,config,input,root})=>{
 for(const change of [{session_id:"other"},{cwd:"other"},{transcript_path:"other"}])assert.equal(run(config,"Stop",{...input,...change},root).status,"scope-mismatch");
 assert.equal(run(config,"Unknown",input,root).status,"unsupported-event");assert.equal(fs.existsSync(c.evidence),false);
}));
test("changed source identity is rejected before delegation",()=>fixture(({c,config,input,root})=>{
 fs.writeFileSync(c.transcript,JSON.stringify({type:"session_meta",payload:{id:"other",cwd:root,source:"vscode",originator:"codex_work_desktop"}})+"\n");
 assert.equal(run(config,"Stop",input,root).status,"source-rejected");assert.equal(fs.existsSync(c.evidence),false);
}));
test("bound synthetic task stages through unchanged candidate with no delivery",()=>fixture(({c,config,input,root})=>{
 const claims={exp:4102444800,github_id:123,aud:"https://synthetic.meter.skillbench.ai"};
 const creds=path.join(c.stateDir,"credentials.json");fs.writeFileSync(creds,JSON.stringify({device_id:"SYNTHETIC",hash_salt:"synthetic-salt",license_jwt:`e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`}));
 const before=fs.readFileSync(creds);
 const env={...process.env,SKILLMETER_STATE_DIR:c.stateDir,PLUGIN_DATA:c.pluginData};delete env.NODE_OPTIONS;
 const enable=spawnSync(process.execPath,[path.join(root,"candidate/scripts/work-local.js"),"enable",c.transcript,c.selected],{env,encoding:"utf8"});assert.equal(enable.status,0,enable.stderr);
 fs.appendFileSync(c.transcript,JSON.stringify({type:"response_item",payload:{type:"message",role:"user",content:"SYNTHETIC-SECRET-SENTINEL"}})+"\n");
 const result=run(config,"Stop",input,root);assert.equal(result.status,"staged");assert.equal(result.networkBlocked,false);assert.equal(result.stopJsonValid,true);
 assert.equal(fs.existsSync(path.join(c.pluginData,"logs/repositories")),false);assert.ok(fs.readFileSync(creds).equals(before));assert.ok(!fs.readFileSync(c.evidence,"utf8").includes("SYNTHETIC-SECRET-SENTINEL"));
}));

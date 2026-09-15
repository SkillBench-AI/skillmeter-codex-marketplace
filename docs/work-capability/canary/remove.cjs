"use strict";
const fs=require("node:fs"),path=require("node:path");
const receiptPath=process.argv[2];
const receipt=JSON.parse(fs.readFileSync(receiptPath,"utf8"));
const config=JSON.parse(fs.readFileSync(receipt.configPath,"utf8"));
process.env.PLUGIN_DATA=config.pluginData;process.env.SKILLMETER_STATE_DIR=config.stateDir;
const result=require(path.join(config.pluginRoot,"scripts/lib/work-runtime")).workCapture().disable();
if (result.status!=="disabled") throw Error("candidate purge still pending; retry removal");
if (fs.existsSync(receipt.hooksPath)) {
  const raw=fs.readFileSync(receipt.hooksPath,"utf8"),current=JSON.parse(raw);
  for(const [event,groups] of Object.entries(receipt.groups)) {
    current.hooks[event]=(current.hooks[event]||[]).filter(g=>!groups.some(own=>JSON.stringify(own)===JSON.stringify(g)));
    if (!current.hooks[event].length) delete current.hooks[event];
  }
  if (fs.readFileSync(receipt.hooksPath,"utf8")!==raw) throw Error("hooks changed during removal");
  if (!receipt.previouslyExisted && Object.keys(current).length===1 && Object.keys(current.hooks).length===0) fs.unlinkSync(receipt.hooksPath);
  else fs.writeFileSync(receipt.hooksPath,JSON.stringify(current,null,2)+"\n",{mode:0o600});
}
console.log(JSON.stringify({candidateDisabled:true,ownHooksRemoved:true,globalTelemetryUnchanged:true}));

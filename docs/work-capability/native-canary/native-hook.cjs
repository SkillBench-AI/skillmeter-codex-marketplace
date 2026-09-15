"use strict";
// Packaged canary entry point. Native discovery/trust dispatches this file;
// unchanged candidate handlers run only for an operator-bound synthetic task.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {spawnSync}=require("node:child_process");
const scripts={SessionStart:"session_start.js",UserPromptSubmit:"user_prompt_submit.js",PreToolUse:"pre_tool_use.js",PostToolUse:"post_tool_use.js",Stop:"stop.js",SessionEnd:"session_end.js",Interrupt:"interrupt.js"};
function run(configPath,event,input,pluginRoot=__dirname) {
  const c=JSON.parse(fs.readFileSync(configPath,"utf8"));
  if (!Number.isFinite(c.expiresAt) || Date.now()>=c.expiresAt) return {status:"expired"};
  if (!Object.hasOwn(scripts,event)) return {status:"unsupported-event"};
  if (!c.selected || typeof c.selected!=="string") return {status:"unselected"};
  if (input.session_id!==c.selected || input.cwd!==c.cwd || input.transcript_path!==c.transcript) return {status:"scope-mismatch"};
  if (fs.lstatSync(c.transcript).isSymbolicLink() || fs.realpathSync(c.transcript)!==c.transcript) return {status:"source-rejected"};
  const candidate=path.join(pluginRoot,"candidate");
  const meta=require(path.join(candidate,"scripts/lib/work-local")).sourceMetadata(c.transcript);
  if (meta.id!==c.selected || meta.cwd!==c.cwd || meta.source!=="vscode" || meta.originator!=="codex_work_desktop") return {status:"source-rejected"};
  const env={...process.env,PLUGIN_ROOT:candidate,CLAUDE_PLUGIN_ROOT:candidate,PLUGIN_DATA:c.pluginData,CLAUDE_PLUGIN_DATA:c.pluginData,SKILLMETER_STATE_DIR:c.stateDir};
  delete env.NODE_OPTIONS;
  const started=performance.now();
  const child=spawnSync(process.execPath,["--require",path.join(pluginRoot,"network-guard.cjs"),path.join(candidate,"scripts",scripts[event])],{env,input:JSON.stringify(input),encoding:"utf8",timeout:2000,maxBuffer:262144});
  const evidence={event,status:child.stderr?.match(/Work local: ([a-z-]+); delivery disabled/)?.[1]||"candidate-no-result",exitCode:child.status,elapsedMs:Math.round(performance.now()-started),networkBlocked:!!child.stderr?.includes("WORK-CANARY-NETWORK-BLOCKED"),stopJsonValid:event!=="Stop"||child.stdout?.trim()==="{}",taskHash:crypto.createHash("sha256").update(c.selected).digest("hex").slice(0,24),nativePluginRootMatches:process.env.PLUGIN_ROOT===pluginRoot,nativePluginDataPresent:!!process.env.PLUGIN_DATA};
  fs.appendFileSync(c.evidence,JSON.stringify(evidence)+"\n",{mode:0o600});
  return evidence;
}
if(require.main===module){
  let body="";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data",data=>{body+=data;if(Buffer.byteLength(body)>1048576)process.exit(0);});
  process.stdin.on("end",()=>{
    try{process.stderr.write(`[work-native-canary] ${run(process.argv[2],process.argv[3],JSON.parse(body)).status}\n`);}
    catch{process.stderr.write("[work-native-canary] unavailable\n");}
    process.stdout.write("{}\n");
  });
}
module.exports={run,scripts};

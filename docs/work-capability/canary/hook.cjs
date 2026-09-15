"use strict";
// Temporary adapter to the exact installed candidate. No history discovery.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const {spawnSync} = require("node:child_process");
const scripts = {
  UserPromptSubmit:"user_prompt_submit.js", PreToolUse:"pre_tool_use.js",
  PostToolUse:"post_tool_use.js", Stop:"stop.js",
};
function run(configPath, input) {
  const config = JSON.parse(fs.readFileSync(configPath,"utf8"));
  if (!Number.isFinite(config.expiresAt) || Date.now() >= config.expiresAt) return {status:"expired"};
  const event = input.hook_event_name;
  if (!Object.hasOwn(scripts,event)) return {status:"unsupported-event"};
  if (input.cwd !== config.cwd || typeof input.session_id !== "string" || !input.session_id) return {status:"scope-mismatch"};
  // These paths are operator-supplied configuration, not model or hook content.
  process.env.PLUGIN_ROOT = config.pluginRoot;
  process.env.PLUGIN_DATA = config.pluginData;
  process.env.SKILLMETER_STATE_DIR = config.stateDir;
  const queue = require(path.join(config.pluginRoot,"scripts/lib/transcript-delta"));
  const release = queue.acquireLock(configPath+".lock");
  if (!release) return {status:"busy"};
  try {
    const latest = JSON.parse(fs.readFileSync(configPath,"utf8"));
    const capture = require(path.join(config.pluginRoot,"scripts/lib/work-runtime")).workCapture();
    if (!latest.selected) {
      if (event !== "UserPromptSubmit" || typeof input.prompt !== "string" || !input.prompt.startsWith(config.marker+".")) return {status:"unselected"};
      const source = input.transcript_path;
      if (typeof source !== "string" || !source.startsWith(config.sessionsRoot+path.sep) || fs.lstatSync(source).isSymbolicLink() || !fs.realpathSync(source).startsWith(fs.realpathSync(config.sessionsRoot)+path.sep)) return {status:"source-rejected"};
      const meta = require(path.join(config.pluginRoot,"scripts/lib/work-local")).sourceMetadata(source);
      if (meta.id !== input.session_id || meta.cwd !== config.cwd || meta.originator !== "codex_work_desktop" || meta.source !== "vscode") return {status:"source-rejected"};
      const enabled = capture.enable(source,input.session_id);
      if (enabled.status !== "enabled-local-only") return {status:enabled.status};
      queue.writeDurable(configPath,JSON.stringify({...latest,selected:input.session_id}));
    } else if (latest.selected !== input.session_id) return {status:"other-task"};
    const start = performance.now();
    const result = spawnSync(process.execPath,["--require",path.join(__dirname,"network-guard.cjs"),path.join(config.pluginRoot,"scripts",scripts[event])],{
      input:JSON.stringify(input),encoding:"utf8",timeout:2000,maxBuffer:262144,env:process.env,
    });
    const status = result.stderr?.match(/Work local: ([a-z-]+); delivery disabled/)?.[1] || "candidate-no-result";
    const evidence = {event,status,elapsedMs:Math.round(performance.now()-start),exitCode:result.status,
      taskHash:crypto.createHash("sha256").update(input.session_id).digest("hex").slice(0,24),
      networkBlocked:!!result.stderr?.includes("WORK-CANARY-NETWORK-BLOCKED"),
      stopJsonValid:event!=="Stop" || result.stdout?.trim()==="{}"};
    // Content-free evidence: never copy stdin, stderr, prompt or tool output.
    fs.appendFileSync(config.evidence,JSON.stringify(evidence)+"\n",{mode:0o600});
    return evidence;
  } finally {release();}
}
if (require.main===module) {
  let body="";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data",data=>{body+=data;if(Buffer.byteLength(body)>1048576)process.exit(0);});
  process.stdin.on("end",()=>{
    try { const outcome=run(process.argv[2],JSON.parse(body));process.stderr.write(`[work-canary] ${outcome.status}\n`); }
    catch {process.stderr.write("[work-canary] unavailable\n");}
    process.stdout.write("{}\n");
  });
}
module.exports={run};

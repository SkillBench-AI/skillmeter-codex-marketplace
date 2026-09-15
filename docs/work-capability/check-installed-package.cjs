"use strict";
// Synthetic package check. This does not attest to desktop hook discovery/trust.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {spawnSync} = require("node:child_process");
const plugin = path.resolve(process.argv[2] || "");
const sourcePlugin = path.resolve(__dirname, "../../plugins/skillmeter");
assert.ok(process.argv[2], "provide the isolated installed plugin directory");
let comparedFiles = 0;
function compare(relative = "") {
  for (const entry of fs.readdirSync(path.join(sourcePlugin, relative), {withFileTypes:true})) {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) compare(file);
    else if (entry.isFile()) {
      assert.ok(fs.readFileSync(path.join(sourcePlugin, file)).equals(fs.readFileSync(path.join(plugin, file))), `installed file differs: ${file}`);
      comparedFiles++;
    } else assert.fail(`unsupported package entry: ${file}`);
  }
}
compare();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-installed-"));
process.env.SKILLMETER_STATE_DIR = path.join(root, "state");
process.env.PLUGIN_DATA = path.join(root, "data");
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.CODEX_HOME = path.join(root, "codex");
// Avoid inheriting command preload settings from the invoking environment.
delete process.env.NODE_OPTIONS;
const line = record => JSON.stringify(record) + "\n";
try {
  fs.mkdirSync(process.env.SKILLMETER_STATE_DIR);
  const creds = path.join(process.env.SKILLMETER_STATE_DIR, "credentials.json");
  function save(exp) {
    const claims = {exp,github_id:123,aud:"https://synthetic.meter.skillbench.ai"};
    fs.writeFileSync(creds, JSON.stringify({device_id:"SYNTHETIC",hash_salt:"synthetic-salt",license_jwt:`e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`}));
  }
  save(4102444800);
  const credentialBytes = fs.readFileSync(creds);
  const transcript = path.join(root, "rollout.jsonl");
  fs.writeFileSync(transcript, line({type:"session_meta",payload:{id:"synthetic-installed",cwd:root,source:"vscode",originator:"codex_work_desktop"}}));
  const capture = require(path.join(plugin,"scripts/lib/work-runtime")).workCapture();
  const queue = require(path.join(plugin,"scripts/lib/transcript-delta"));
  const pending = () => queue.queueDirectories(path.join(process.env.PLUGIN_DATA,"logs/work-local-v1/chunks")).flatMap(queue.pendingFiles);
  capture.enable(transcript, "synthetic-installed");
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin,"hooks/hooks.json")));
  const invoked = [];
  for (const [event, groups] of Object.entries(manifest.hooks)) {
    fs.appendFileSync(transcript,line({type:"response_item",payload:{type:"message",role:"user",content:`Synthetic event ${event}`}}));
    for (const group of groups) for (const hook of group.hooks) {
      const match = /^node \$\{PLUGIN_ROOT\}\/([a-z_/.]+\.js)$/.exec(hook.command);
      assert.ok(match, "explicitly review changed manifest command before execution");
      const result = spawnSync(process.execPath,["--require",path.join(__dirname,"canary/network-guard.cjs"),path.join(plugin,match[1])],{
        env:process.env,encoding:"utf8",timeout:10000,
        input:JSON.stringify({session_id:"synthetic-installed",cwd:root,transcript_path:transcript}),
      });
      assert.equal(result.status,0,`${event}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr,/WORK-CANARY-NETWORK-BLOCKED/);
      if (event === "Stop") assert.deepEqual(JSON.parse(result.stdout),{});
      invoked.push(event);
    }
  }
  capture.reconcile();
  assert.ok(fs.readFileSync(creds).equals(credentialBytes), "hooks changed shared credentials");
  const before = pending().map(file => [file,fs.readFileSync(file)]);
  assert.ok(before.length > 0);
  save(1);
  assert.equal(capture.reconcile().status,"unchanged");
  assert.equal(capture.status().tokenExpired,true);
  for (const [file,bytes] of before) assert.ok(fs.readFileSync(file).equals(bytes));
  assert.deepEqual(require(path.join(plugin,"scripts/logger")).listPendingTranscripts(),[]);
  capture.disable();
  assert.equal(pending().length,0);
  process.stdout.write(JSON.stringify({status:"passed",comparedFiles,manifestEvents:invoked,stagedChunks:before.length,expiryRetained:true,credentialsUnchangedDuringHooks:true,productionQueueEmpty:true,cleanup:true,desktopNativeDispatch:"not-tested"},null,2)+"\n");
} finally {
  fs.rmSync(root,{recursive:true,force:true});
}

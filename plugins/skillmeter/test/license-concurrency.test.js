"use strict";
const {test,after} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const {spawn} = require("node:child_process");
const {once} = require("node:events");
const root = fs.mkdtempSync(path.join(os.tmpdir(),"codex-license-race-"));
os.homedir = () => root;
process.env.SKILLMETER_STATE_DIR = path.join(root,"state");
process.env.PLUGIN_DATA = path.join(root,"data");
fs.mkdirSync(process.env.SKILLMETER_STATE_DIR);
const token = exp => "e30." + Buffer.from(JSON.stringify({exp,github_id:123,org:{login:"synthetic"},aud:"https://synthetic.meter.skillbench.ai"})).toString("base64url") + ".fixture";
fs.writeFileSync(path.join(process.env.SKILLMETER_STATE_DIR,"credentials.json"),JSON.stringify({device_id:"SYNTHETIC",hash_salt:"fixture",license_jwt:token(1)}));
const activation = require("../scripts/lib/license-activation");
after(() => fs.rmSync(root,{recursive:true,force:true}));

test("another process owns refresh until it exits; a crashed owner is recovered", {timeout:10000}, async t => {
  const modulePath = path.resolve(__dirname,"../scripts/lib/transcript-delta");
  const script = `
    const path = require("node:path");
    require("node:net").Socket.prototype.connect = () => {throw Error("network disabled")};
    const release = require(process.argv[1]).acquireLock(path.join(process.env.SKILLMETER_STATE_DIR,".codex-license-refresh.lock"));
    if (!release) process.exit(2);
    process.stdout.write("ready\\n");
    process.stdin.resume();
  `;
  const child = spawn(process.execPath,["-e",script,modulePath],{env:{HOME:root,SKILLMETER_STATE_DIR:process.env.SKILLMETER_STATE_DIR},stdio:["pipe","pipe","pipe"]});
  t.after(() => child.kill("SIGKILL"));
  const exited = once(child,"exit");
  await Promise.race([
    once(child.stdout,"data").then(([data]) => assert.equal(data.toString(),"ready\n")),
    exited.then(() => assert.fail("lock owner exited before ready")),
  ]);
  const original = global.fetch;
  const fresh = token(Math.floor(Date.now()/1000)+3600);
  let requests = 0;
  global.fetch = async url => {assert.equal(new URL(url).pathname,"/refresh"); requests++; return {ok:true,status:200,json:async()=>({token:fresh})};};
  try {
    assert.equal(await activation.ensureFreshLicense("SYNTHETIC"),null);
    assert.equal(requests,0);
    child.kill("SIGKILL"); await exited;
    assert.equal(await activation.ensureFreshLicense("SYNTHETIC"),fresh);
    assert.equal(requests,1);
  } finally {global.fetch = original;}
});

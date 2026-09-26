"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), cp = require("node:child_process");
for (const outcome of ["stop", "abort", "ownership"]) test(`overlap receiver requires owned upload and newer Stop: ${outcome}`, t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "overlap-receiver-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const name of ["data/logs", "received", "attempts"]) fs.mkdirSync(path.join(base, name), { recursive: true });
  const write = (name, value) => fs.writeFileSync(path.join(base, name), JSON.stringify(value));
  write("config.json", { expiresAt: Date.now() + 60000 }); write("receiver.json", { status: 200 });
  write("overlap.json", { label: "a", callbackCount: 0, expiresAt: Date.now() + 60000 });
  fs.writeFileSync(path.join(base, "callbacks.jsonl"), "");
  fs.copyFileSync(path.join(__dirname, "guard.cjs"), path.join(base, "guard.cjs"));
  const r = cp.spawnSync(process.execPath, ["-e", `
    const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
    const base=${JSON.stringify(base)}, outcome=${JSON.stringify(outcome)};
    const file=n=>path.join(base,n), write=(n,v)=>fs.writeFileSync(file(n),v);
    write('data/logs/.drain-once.worker.lock',JSON.stringify({pid:process.pid}));
    write('data/logs/.drain-once.request','first');
    require(file('guard.cjs'));
    (async()=>{
      const controller=new AbortController();
      const pending=fetch('https://consent-canary.meter.dev/logs/codex/transcript',{body:Buffer.from('synthetic'),headers:{'X-Chunk-Seq':'1'},signal:controller.signal});
      assert.ok(fs.existsSync(file('overlap-held.json')));
      assert.ok(!fs.existsSync(file('overlap-release.json')));
      if(outcome==='abort') controller.abort();
      else if(outcome==='ownership') write('data/logs/.drain-once.worker.lock',JSON.stringify({pid:1}));
      else {
        write('data/logs/.drain-once.request','second');
        write('callbacks.jsonl',JSON.stringify({label:'a',hook:'stop.js',outcome:'candidate-completed',at:new Date().toISOString()})+'\\n');
      }
      if(outcome==='stop') {assert.equal((await pending).status,200);assert.ok(fs.existsSync(file('overlap-release.json')));}
      else {await assert.rejects(pending,/overlap-/);assert.equal(fs.readdirSync(file('received')).length,0);}
    })().catch(e=>{console.error(e);process.exitCode=1});
  `], { encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, r.stderr);
});

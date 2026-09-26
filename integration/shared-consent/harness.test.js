"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), cp = require("node:child_process");
const { prepare } = require("./prepare.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared harness-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claude = path.join(root, "claude-source"); fs.mkdirSync(claude);
  const git = args => {
    const r = cp.spawnSync("git", ["-C", claude, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" } });
    assert.equal(r.status, 0, r.stderr);
  };
  // A spy verifies delegation/isolation only. Canonical policy behavior is checked
  // separately with the pinned Claude source during the local rehearsal.
  fs.mkdirSync(path.join(claude, "skillmeter/scripts/lib"), { recursive: true });
  fs.writeFileSync(path.join(claude, "skillmeter/scripts/lib/telemetry-store.js"), `
    const fs=require('node:fs'),path=require('node:path');
    const record=(...args)=>fs.writeFileSync(path.join(process.env.SKILLMETER_STATE_DIR,'control-spy.json'),JSON.stringify(args));
    module.exports={setGlobalEnabled:v=>record('global',v),setOrganizationConsent:(k,v)=>record('org',k,v),
      getPolicyRevision:()=>7,setRepositoryOverride:(k,v,r)=>record('repo',k,v,r)};
  `);
  git(["init", "--quiet"]); git(["add", "."]);
  git(["-c", "user.name=Synthetic", "-c", "user.email=canary@example.invalid", "commit", "-qm", "Synthetic control spy"]);
  const base = path.join(root, "canary"); prepare(base, claude);
  const run = (args, input) => cp.spawnSync(process.execPath, [path.join(base, "run.cjs"), ...args], {
    input: input && JSON.stringify(input), encoding: "utf8", timeout: 10000,
    env: { PATH: process.env.PATH, HOME: path.join(root, "unrelated-home") },
  });
  const ok = (args, input) => { const r = run(args, input); assert.equal(r.status, 0, r.stderr); return r; };
  const cfg = JSON.parse(fs.readFileSync(path.join(base, "config.json")));
  const policyFile = path.join(base, "home/.skillbench/telemetry-policy.json");
  const policy = () => fs.writeFileSync(policyFile, JSON.stringify({ schema_version: 1, revision: 1, global: { enabled: true },
    organizations: { acme: { enabled: true } }, repositories: { "github.com/acme/widgets": { enabled: true }, "github.com/acme/other": { enabled: true } } }));
  function bind(label) {
    const source = path.join(base, label + ".jsonl"), id = "synthetic-" + label;
    fs.writeFileSync(source, JSON.stringify({ type: "session_meta", payload: { id, cwd: cfg.workspaces[label], source: "cli" } }) + "\n");
    ok(["bind", label, id, source]);
    return { cwd: cfg.workspaces[label], session_id: id, transcript_path: source, tool_name: "synthetic", tool_input: {} };
  }
  return { root, base, cfg, run, ok, policy, policyFile, bind };
}

test("preparation leaves hooks inactive and refuses existing destinations", t => {
  const f = fixture(t);
  assert.equal(JSON.parse(f.ok(["status"]).stdout).armed, false);
  for (const cwd of Object.values(f.cfg.workspaces)) assert.equal(fs.existsSync(path.join(cwd, ".codex/hooks.json")), false);
  assert.throws(() => prepare(f.base, f.root), /existing directories/);
  assert.notEqual(f.run(["local", "a", "enable"]).status, 0);
  assert.equal(f.ok(["hook", "pre_tool_use.js"], { cwd: f.cfg.workspaces.a, session_id: "unbound" }).stdout.trim(), "{}");
});

test("unselected/wrong-session callbacks cannot capture; shared ON still requires local choice", t => {
  const f = fixture(t); f.ok(["arm"]); f.policy();
  f.ok(["hook", "pre_tool_use.js"], { cwd: f.cfg.workspaces.a, session_id: "trust-only" });
  assert.deepEqual(fs.readdirSync(path.join(f.base, "bindings")), []);
  const h = f.bind("a"); f.ok(["hook", "pre_tool_use.js"], h);
  const events = path.join(f.base, "data/logs/events.jsonl");
  assert.equal(fs.existsSync(events), false);
  f.ok(["local", "a", "enable"]);
  f.ok(["hook", "pre_tool_use.js"], { ...h, session_id: "wrong" });
  assert.equal(fs.existsSync(events), false);
  f.ok(["hook", "pre_tool_use.js"], h);
  assert.equal(fs.readFileSync(events, "utf8").trim().split("\n").length, 1);
  assert.equal(fs.existsSync(path.join(f.root, "unrelated-home")), false);
});

test("binding rejects wrong project or identity and hook source substitution", t => {
  const f = fixture(t); f.ok(["arm"]); f.policy(); const h = f.bind("a");
  assert.notEqual(f.run(["bind", "b", h.session_id, h.transcript_path]).status, 0);
  assert.notEqual(f.run(["bind", "a", "wrong", h.transcript_path]).status, 0);
  const other = f.bind("b"); f.ok(["local", "a", "enable"]);
  f.ok(["hook", "pre_tool_use.js"], { ...h, transcript_path: other.transcript_path });
  f.ok(["hook", "subagent_stop.js"], { ...h, agent_transcript_path: other.transcript_path });
  assert.equal(fs.existsSync(path.join(f.base, "data/logs/events.jsonl")), false);
});

test("shared controls call the supplied Claude store with canonical identity and revision", t => {
  const f = fixture(t); f.ok(["arm"]);
  const spy = () => JSON.parse(fs.readFileSync(path.join(f.base, "home/.skillbench/control-spy.json")));
  for (const label of ["a", "clone", "worktree"]) {
    f.ok(["shared", "repo", label, "off"]);
    assert.deepEqual(spy(), ["repo", "github.com/acme/widgets", false, 7]);
  }
  f.ok(["shared", "repo", "b", "on"]); assert.deepEqual(spy(), ["repo", "github.com/acme/other", true, 7]);
  f.ok(["shared", "global", "off"]); assert.deepEqual(spy(), ["global", false]);
  f.ok(["shared", "org", "on"]); assert.deepEqual(spy(), ["org", "acme", true]);
});

test("missing transcript paths are unselected callbacks, not hook errors", t => {
  const f = fixture(t); f.ok(["arm"]); f.policy(); const h = f.bind("a");
  f.ok(["local", "a", "enable"]);
  for (const field of ["transcript_path", "agent_transcript_path"]) {
    assert.equal(f.ok(["hook", "pre_tool_use.js"], { ...h, [field]: path.join(f.base, "missing.jsonl") }).stdout.trim(), "{}");
  }
  const outcomes = fs.readFileSync(path.join(f.base, "callbacks.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(outcomes.map(row => row.outcome), ["unselected", "unselected"]);
  assert.equal(fs.existsSync(path.join(f.base, "data/logs/events.jsonl")), false);
});

test("guard blocks outbound networking/processes and intercepts only the fake collector", t => {
  const f = fixture(t); f.ok(["arm"]);
  const r = cp.spawnSync(process.execPath, ["--require", path.join(f.base, "guard.cjs"), "-e", `
    const assert=require('node:assert/strict'), cp=require('node:child_process');
    assert.throws(()=>require('node:https').get('https://example.com'),/blocked/);
    assert.throws(()=>require('node:net').connect(443,'example.com'),/blocked/);
    assert.throws(()=>cp.spawnSync('security',[]),/blocked/);
    assert.throws(()=>cp.spawn('curl',[]),/blocked/);
    (async()=>{
      await assert.rejects(()=>fetch('https://example.com',{}),/blocked/);
      const r=await fetch('https://consent-canary.meter.dev/logs/codex',{body:Buffer.from('synthetic'),headers:{}});
      assert.equal(r.status,503);
      require('node:fs').writeFileSync(${JSON.stringify(path.join(f.base, "disabled"))},'retired');
      await assert.rejects(()=>fetch('https://consent-canary.meter.dev/logs/codex',{body:Buffer.from('late')}),/blocked/);
    })().catch(e=>{console.error(e);process.exitCode=1});
  `], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readdirSync(path.join(f.base, "attempts")).length, 2);
  assert.equal(fs.readdirSync(path.join(f.base, "received")).length, 0);
});

test("expiration and retirement stop callbacks; retirement preserves edited hooks", t => {
  const f = fixture(t); f.ok(["arm"]); const h = f.bind("a"); f.policy(); f.ok(["local", "a", "enable"]);
  fs.writeFileSync(path.join(f.base, "config.json"), JSON.stringify({ ...f.cfg, expiresAt: 1 }));
  f.ok(["hook", "pre_tool_use.js"], h);
  assert.equal(fs.existsSync(path.join(f.base, "data/logs/events.jsonl")), false);
  const edited = path.join(f.cfg.workspaces.b, ".codex/hooks.json"); fs.writeFileSync(edited, "user edit");
  f.ok(["retire"]);
  assert.equal(fs.readFileSync(edited, "utf8"), "user edit");
  assert.equal(fs.existsSync(path.join(f.cfg.workspaces.a, ".codex/hooks.json")), false);
});

test("guard permits the requested drain handshake but rejects other worker arguments", t => {
  const f = fixture(t); f.ok(["arm"]);
  const r = cp.spawnSync(process.execPath, ["-e", `
    const assert=require('node:assert/strict'),cp=require('node:child_process');
    const calls=[]; cp.spawn=(...args)=>{calls.push(args);return {pid:1};};
    require(${JSON.stringify(path.join(f.base, "guard.cjs"))});
    const worker=${JSON.stringify(path.join(fs.realpathSync(f.base), "codex/scripts/drain_once.js"))};
    cp.spawn(process.execPath,[worker]);
    cp.spawn(process.execPath,[worker,'--requested']);
    assert.equal(calls.length,2);
    for(const args of [[worker,'--other'],[worker,'--requested','extra'],['other.js','--requested']])
      assert.throws(()=>cp.spawn(process.execPath,args),/blocked/);
  `], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, r.stderr);
});


test("candidate consent controls remain isolated and pass explicit confirmation arguments", t => {
  const f = fixture(t);
  assert.notEqual(f.run(["consent", "a", "preview"]).status, 0);
  f.ok(["arm"]);
  const spyFile = path.join(f.base, "data/consent-spy.json");
  fs.writeFileSync(path.join(f.base, "codex/scripts/telemetry.js"), `
    require('node:fs').writeFileSync(${JSON.stringify(spyFile)}, JSON.stringify({
      args:process.argv.slice(2),cwd:process.cwd(),home:process.env.HOME,state:process.env.SKILLMETER_STATE_DIR
    }));
  `);
  f.ok(["consent", "clone", "preview"]);
  let spy = JSON.parse(fs.readFileSync(spyFile));
  assert.deepEqual(spy.args, ["consent-preview", "--json"]);
  assert.equal(spy.cwd, fs.realpathSync(f.cfg.workspaces.clone));
  assert.equal(spy.home, fs.realpathSync(path.join(f.base, "home")));
  assert.equal(spy.state, fs.realpathSync(path.join(f.base, "home/.skillbench")));
  const confirmation = ["--repository", "github.com/acme/widgets", "--revision", "7", "--acknowledge-machine-scope"];
  f.ok(["consent", "worktree", "on", ...confirmation]);
  spy = JSON.parse(fs.readFileSync(spyFile));
  assert.deepEqual(spy.args, ["consent-set", "on", ...confirmation]);
  assert.equal(spy.cwd, fs.realpathSync(f.cfg.workspaces.worktree));
  f.ok(["consent", "a", "off", "--repository", "github.com/acme/widgets", "--revision", "8"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(spyFile)).args,
    ["consent-set", "off", "--repository", "github.com/acme/widgets", "--revision", "8"]);
  assert.notEqual(f.run(["consent", "a", "signin"]).status, 0);
  assert.notEqual(f.run(["consent", "unknown", "preview"]).status, 0);
  assert.notEqual(f.run(["consent", "a", "preview", "ignored"]).status, 0);
  f.ok(["retire"]);
  assert.notEqual(f.run(["consent", "a", "on", ...confirmation]).status, 0);
  assert.equal(fs.existsSync(path.join(f.root, "unrelated-home")), false);
});

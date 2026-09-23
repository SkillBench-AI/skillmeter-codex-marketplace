"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const plugin = path.resolve(__dirname, "..");
const roots = [];
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-consent-"));
  roots.push(root);
  const repo = path.join(root, "repo"), data = path.join(root, "data");
  const state = path.join(root, ".skillbench");
  fs.mkdirSync(state);
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git/config"), '[remote "origin"]\nurl = https://github.com/acme/widgets.git\n');
  const settings = path.join(repo, ".codex/settings.local.json");
  const credentials = { device_id: "SYNTHETIC", hash_salt: "synthetic-salt", allowed_github_orgs: ["acme"],
    license_jwt: `h.${Buffer.from(JSON.stringify({ exp: 4102444800, sub: "tenant", github_id: "person", aud: "https://acme.meter.skillbench.ai" })).toString("base64url")}.s` };
  const credentialFile = path.join(state, "credentials.json");
  const saveCredentials = patch => fs.writeFileSync(credentialFile, JSON.stringify({ ...credentials, ...patch }));
  saveCredentials({});
  const preload = path.join(root, "preload.cjs");
  fs.writeFileSync(preload, `
global.fetch = () => { throw Error("unexpected network"); };
const cp = require("child_process");
cp.execSync = () => { throw Error("unexpected shell"); };
cp.spawn = () => { require("fs").appendFileSync(process.env.TEST_SPAWNS, "spawn\\n"); return { pid: 999999, unref() {} }; };
`);
  function run(script, args = [], cwd = repo, input = {}) {
    return spawnSync(process.execPath, ["--require", preload, path.join(plugin, "scripts", script), ...args], {
      cwd, encoding: "utf8", timeout: 5000,
      input: JSON.stringify({ session_id: "synthetic-session", cwd, tool_name: "synthetic", tool_input: { message: "synthetic event" }, ...input }),
      env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, ".codex"),
        PLUGIN_ROOT: plugin, PLUGIN_DATA: data, SKILLMETER_STATE_DIR: state,
        SKILLMETER_REPO_SCOPE_ORGS: "", NODE_OPTIONS: "", TEST_SPAWNS: path.join(root, "spawns") },
    });
  }
  const control = (action, cwd = repo) => {
    const result = run("telemetry.js", [action], cwd);
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  const hook = (cwd = repo, input = {}) => {
    const result = run("pre_tool_use.js", [], cwd, input);
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  const events = () => {
    const file = path.join(data, "logs/events.jsonl");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  };
  return { root, repo, data, settings, credentialFile, saveCredentials, run, control, hook, events };
}

test("an unselected owned repository creates no events or capture hints", () => {
  const f = fixture();
  const source = path.join(f.root, "synthetic.jsonl");
  fs.writeFileSync(source, '{}\n');
  const result = f.hook(f.repo, { transcript_path: source });
  assert.deepEqual(f.events(), []);
  assert.equal(fs.existsSync(path.join(f.data, "logs/transcripts/captures-v1")), false);
  assert.equal(fs.existsSync(path.join(f.root, "spawns")), false);
  assert.match(result.stderr, /telemetry not enabled/);
});

test("explicit enable persists across hook processes; disable stops new capture", () => {
  const f = fixture();
  f.control("enable");
  f.hook(); f.hook();
  assert.equal(f.events().length, 2);
  f.control("disable");
  f.hook();
  assert.equal(f.events().length, 0);
});

test("repository-root choice applies to hooks and controls in subdirectories", () => {
  const f = fixture();
  const subdir = path.join(f.repo, "src");
  fs.mkdirSync(subdir);
  f.control("enable", subdir);
  assert.equal(JSON.parse(fs.readFileSync(f.settings)).skillmeter.telemetry, true);
  assert.equal(fs.existsSync(path.join(subdir, ".codex/settings.local.json")), false);
  f.hook(); f.hook(subdir);
  assert.equal(f.events().length, 2);
  f.control("disable", subdir);
  f.hook(); f.hook(subdir);
  assert.equal(f.events().length, 0);
});

test("parent consent does not enable an unselected nested repository", () => {
  const f = fixture();
  f.control("enable");
  const nested = path.join(f.repo, "nested");
  fs.mkdirSync(path.join(nested, ".git"), { recursive: true });
  fs.writeFileSync(path.join(nested, ".git/config"), '[remote "origin"]\nurl = https://github.com/acme/another.git\n');
  f.hook(nested);
  assert.deepEqual(f.events(), []);
});

test("global pause and scope exclusion override explicit repository enablement", () => {
  const f = fixture();
  f.control("enable");
  f.saveCredentials({ telemetry_disabled: true }); f.hook();
  assert.deepEqual(f.events(), []);
  f.saveCredentials({ allowed_github_orgs: ["another"] }); f.hook();
  assert.deepEqual(f.events(), []);
  f.saveCredentials({}); f.hook();
  assert.equal(f.events().length, 1);
});

test("missing or malformed consent never authorizes capture", () => {
  for (const value of ['{', 'null', '[]', '{"skillmeter":{"telemetry":"true"}}']) {
    const f = fixture();
    fs.mkdirSync(path.dirname(f.settings));
    fs.writeFileSync(f.settings, value);
    f.hook();
    assert.deepEqual(f.events(), [], value);
  }
});

test("CLI refuses to overwrite malformed settings while enabling", () => {
  const f = fixture();
  fs.mkdirSync(path.dirname(f.settings));
  fs.writeFileSync(f.settings, '{');
  const result = f.run("telemetry.js", ["enable"]);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(f.settings, "utf8"), '{');
});

test("repository controls preserve other settings and shared credentials", () => {
  const f = fixture();
  fs.mkdirSync(path.dirname(f.settings));
  fs.writeFileSync(f.settings, JSON.stringify({ unrelated: "keep", skillmeter: { repoScopeOrgs: ["acme"] } }));
  const before = fs.readFileSync(f.credentialFile);
  f.control("enable"); f.control("disable");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)), { unrelated: "keep", skillmeter: { repoScopeOrgs: ["acme"], telemetry: false } });
  assert.deepEqual(fs.readFileSync(f.credentialFile), before);
});

test("legacy subdirectory opt-out stays restrictive under a root opt-in", () => {
  const f = fixture(); f.control("enable");
  const subdir = path.join(f.repo, "src");
  fs.mkdirSync(path.join(subdir, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(subdir, ".codex/settings.local.json"), '{"skillmeter":{"telemetry":false}}');
  f.hook(subdir);
  assert.deepEqual(f.events(), []);
});

test("SessionStart requests a choice without starting monitors for an unselected repo", () => {
  const f = fixture();
  const result = f.run("session_start.js");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Telemetry is not configured/);
  assert.doesNotMatch(result.stderr, /auto-enabled|\(activated\)/);
  assert.equal(fs.existsSync(path.join(f.root, "spawns")), false);
  assert.deepEqual(f.events(), []);
});

test("SessionStart does not start monitors for an opted-in out-of-scope repo", () => {
  const f = fixture(); f.control("enable");
  f.saveCredentials({ allowed_github_orgs: ["another"] });
  const result = f.run("session_start.js");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /repository out of scope/);
  assert.equal(fs.existsSync(path.join(f.root, "spawns")), false);
  assert.deepEqual(f.events(), []);
});

test("Stop hooks retain their JSON protocol while consent blocks capture", () => {
  const f = fixture();
  for (const script of ["stop.js", "subagent_stop.js"]) {
    const result = f.run(script);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  }
  assert.equal(fs.existsSync(path.join(f.root, "spawns")), false);
  assert.deepEqual(f.events(), []);
});

test("a subdirectory opt-in cannot authorize the repository", () => {
  const f = fixture();
  const subdir = path.join(f.repo, "src");
  fs.mkdirSync(path.join(subdir, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(subdir, ".codex/settings.local.json"), '{"skillmeter":{"telemetry":true}}');
  f.hook(subdir); f.hook();
  assert.deepEqual(f.events(), []);
});

for (const value of [42, [], { skillmeter: [] }, { skillmeter: null },
  { skillmeter: { telemetry: "false" } }, { skillmeter: { telemetry: [] } },
  { skillmeter: { telemetry: 42 } }, { skillmeter: { telemetry: null } }]) {
  test(`malformed descendant settings block root consent: ${JSON.stringify(value)}`, () => {
    const f = fixture(); f.control("enable");
    const subdir = path.join(f.repo, "src");
    fs.mkdirSync(path.join(subdir, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(subdir, ".codex/settings.local.json"), JSON.stringify(value));
    f.hook(subdir);
    assert.deepEqual(f.events(), []);
    assert.equal(fs.existsSync(path.join(f.root, "spawns")), false);
  });
}

for (const value of [{ unrelated: true }, { skillmeter: {} }, { skillmeter: { telemetry: true } }]) {
  test(`valid descendant settings retain root consent: ${JSON.stringify(value)}`, () => {
    const f = fixture(); f.control("enable");
    const subdir = path.join(f.repo, "src");
    fs.mkdirSync(path.join(subdir, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(subdir, ".codex/settings.local.json"), JSON.stringify(value));
    f.hook(subdir);
    assert.equal(f.events().length, 1);
  });
}

test("routing lock contention preserves the Stop hook's JSON and reports a retryable control failure", () => {
  const f = fixture();
  f.control("enable");
  const routing = path.join(f.data, "logs/repository-routing");
  const id = require("node:crypto").createHmac("sha256", "synthetic-salt").update(fs.realpathSync(f.repo)).digest("hex").slice(0, 12);
  const release = require("../scripts/lib/transcript-delta").acquireLock(path.join(routing, `${id}.json.lock`));
  assert.ok(release);
  try {
    const hook = f.run("stop.js");
    assert.equal(hook.status, 0, hook.stderr);
    assert.deepEqual(JSON.parse(hook.stdout), {});
    assert.match(hook.stderr, /repository routing unavailable/);
    assert.deepEqual(f.events(), []);
    const control = f.run("telemetry.js", ["disable"]);
    assert.equal(control.status, 1);
    assert.match(control.stderr, /busy.*retry/i);
    assert.equal(JSON.parse(fs.readFileSync(f.settings)).skillmeter.telemetry, true);
  } finally { release(); }
  f.control("disable");
  assert.equal(JSON.parse(fs.readFileSync(f.settings)).skillmeter.telemetry, false);
});


for (const spelling of ["relative", "trailing slash"]) {
  test(`hook cwd normalization matches routing keys: ${spelling}`, () => {
    const f = fixture();
    f.control("enable");
    f.hook(f.repo, { cwd: spelling === "relative" ? "." : `${f.repo}/` });
    const [event] = f.events();
    const resolved = spelling === "relative" ? fs.realpathSync(f.repo) : f.repo;
    const expected = require("node:crypto").createHmac("sha256", "synthetic-salt").update(resolved).digest("hex").slice(0, 12);
    assert.equal(event.data.cwd, expected);
    const routing = path.join(f.data, "logs/repository-routing");
    const states = fs.readdirSync(routing).filter(name => name.endsWith(".json")).map(name => JSON.parse(fs.readFileSync(path.join(routing, name))));
    assert.ok(states.some(state => state.directories?.[event.data.cwd] === resolved));
  });
}

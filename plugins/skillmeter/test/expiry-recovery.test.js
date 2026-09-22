"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const roots = [];
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const plugin = path.resolve(__dirname, "..");
const jwt = claims => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-expiry-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  const data = path.join(root, "data");
  const calls = path.join(root, "calls.jsonl");
  const credentialsPath = path.join(root, ".skillbench/credentials.json");
  const start = Date.now();
  const claims = { sub: "tenant-test", broker_sub: "person-test", org: { login: "acme" }, aud: "https://acme.meter.skillbench.ai" };
  const token = jwt({ ...claims, exp: Math.floor(start / 1000) + 900 });
  const credentials = { device_id: "TEST-DEVICE", hash_salt: "synthetic-salt", license_jwt: token, allowed_github_orgs: ["acme"], orgs_explicitly_set: true };
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(credentialsPath, JSON.stringify(credentials));
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git/config"), '[remote "origin"]\nurl = https://github.com/acme/widgets.git\n');
  fs.mkdirSync(path.join(repo, ".codex"));
  fs.writeFileSync(path.join(repo, ".codex/settings.local.json"), JSON.stringify({ skillmeter: { telemetry: true } }));
  const preload = path.join(root, "preload.cjs");
  fs.writeFileSync(preload, `
const fs = require("fs"), cp = require("child_process");
Date.now = () => Number(process.env.TEST_NOW);
const record = value => fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(value) + "\\n");
cp.spawn = (file, args) => { record({ spawn: args }); return { pid: 999999, unref() {} }; };
cp.execSync = () => { throw new Error("No GitHub CLI in this fixture"); };
global.fetch = async (url, options) => {
  record({ url: String(url) });
  if (String(url) === "https://api.skillbench.ai/refresh") {
    const status = Number(process.env.TEST_REFRESH_STATUS || 200);
    return { ok: status === 200, status, json: async () => ({ token: process.env.TEST_FRESH }), text: async () => "synthetic failure" };
  }
  if (!String(url).startsWith("https://acme.meter.skillbench.ai/")) throw new Error("Unexpected URL");
  const token = options.headers.Authorization.replace(/^Bearer /, "");
  const exp = JSON.parse(Buffer.from(token.split(".")[1], "base64url")).exp;
  if (exp * 1000 <= Date.now()) throw new Error("Expired upload attempted");
  const events = require("zlib").gunzipSync(options.body).toString().trim().split("\\n").map(JSON.parse);
  record({ uploaded: events.map(event => event.hook_event_name), messages: events.map(event => event.data.last_assistant_message) });
  return { ok: true, status: 200, text: async () => "ok" };
};
`);
  function run(script, minute, extra = {}) {
    const now = start + minute * 60_000;
    const result = spawnSync(process.execPath, ["--require", preload, path.join(plugin, "scripts", script)], {
      cwd: repo, encoding: "utf8", timeout: 5000,
      input: JSON.stringify({ session_id: "synthetic", cwd: repo, last_assistant_message: `synthetic turn ${minute}` }),
      env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, ".codex"),
        PLUGIN_ROOT: plugin, PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PLUGIN_DATA: data,
        SKILLMETER_STATE_DIR: path.dirname(credentialsPath), SKILLMETER_ACTIVATE_URL: "", SKILLMETER_BACKEND_URL: "",
        SKILLMETER_GITHUB_ORGS: "", NODE_OPTIONS: "", TEST_NOW: String(now), TEST_CALLS: calls,
        TEST_FRESH: jwt({ ...claims, exp: Math.floor(now / 1000) + 900 }), ...extra },
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return result;
  }
  return { data, repo, credentials, credentialsPath, token,
    hook: minute => run("stop.js", minute),
    drain: (minute, extra) => run("drain_once.js", minute, extra),
    records: () => fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [],
  };
}

test("Stop captures after token expiry and its detached drain recovers without a monitor", () => {
  const f = fixture();
  const hook = f.hook(16);
  assert.equal(hook.stdout.trim(), "{}");
  assert.match(hook.stderr, /logged/);
  assert.equal(f.records().filter(r => r.spawn).length, 1);
  assert.equal(f.records().filter(r => r.url).length, 0);
  f.drain(16);
  assert.equal(f.records().filter(r => r.url?.endsWith("/refresh")).length, 1);
  assert.deepEqual(f.records().flatMap(r => r.uploaded || []), ["Stop"]);
});

test("active turns deliver exactly once across two token lifetimes with no monitor", () => {
  const f = fixture();
  for (let minute = 0; minute <= 34; minute += 2) {
    assert.match(f.hook(minute).stderr, /logged/);
    f.drain(minute);
  }
  assert.equal(f.records().filter(r => r.url?.endsWith("/refresh")).length, 3);
  assert.deepEqual(f.records().flatMap(r => r.uploaded || []), Array(18).fill("Stop"));
  assert.deepEqual(f.records().flatMap(r => r.messages || []), Array.from({ length: 18 }, (_, i) => `synthetic turn ${i * 2}`));
});

test("a failed expired refresh preserves the sealed event until later recovery", () => {
  const f = fixture();
  f.hook(16);
  const logs = path.join(f.data, "logs");
  const sealed = fs.readdirSync(logs).find(name => /^events\.jsonl\.\d+$/.test(name));
  assert.ok(sealed);
  const before = fs.readFileSync(path.join(logs, sealed));
  f.drain(16, { TEST_REFRESH_STATUS: "503" });
  assert.deepEqual(fs.readFileSync(path.join(logs, sealed)), before);
  assert.deepEqual(f.records().flatMap(r => r.uploaded || []), []);
  f.drain(20);
  assert.deepEqual(f.records().flatMap(r => r.uploaded || []), ["Stop"]);
});

test("signout after a hook blocks a pending worker from refreshing or sending", () => {
  const f = fixture();
  f.hook(16);
  const { license_jwt, ...rest } = f.credentials;
  fs.writeFileSync(f.credentialsPath, JSON.stringify({ ...rest, signed_out: true, telemetry_disabled: true }));
  f.drain(16);
  assert.equal(f.records().filter(r => r.url).length, 0);
  assert.match(f.hook(17).stderr, /globally disabled/);
});

test("project opt-out suppresses new capture and worker launch", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.repo, ".codex/settings.local.json"), JSON.stringify({ skillmeter: { telemetry: false } }));
  assert.match(f.hook(16).stderr, /disabled for this project/);
  assert.deepEqual(f.records(), []);
});

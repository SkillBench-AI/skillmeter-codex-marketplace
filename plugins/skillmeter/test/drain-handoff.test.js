"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const plugin = path.resolve(__dirname, "..");

function preloadFixture() {
  const fs = require("fs"), cp = require("child_process"), path = require("path");
  const root = process.env.TEST_ROOT;
  const record = (file, value) => fs.appendFileSync(path.join(root, file), JSON.stringify(value) + "\n");
  cp.execSync = () => { throw Error("unexpected shell/Keychain access"); };
  cp.spawn = (_, args) => {
    if (!args[0].endsWith("/drain_once.js")) throw Error("unexpected background worker");
    record("spawns.jsonl", {});
    return { pid: 999999, unref() {} };
  };
  const injectStop = () => {
    if (!fs.existsSync(path.join(root, "injected"))) {
      fs.writeFileSync(path.join(root, "injected"), "");
      if (process.env.TEST_INJECT === "paused") {
        const file = path.join(root, ".skillbench/credentials.json");
        const credentials = JSON.parse(fs.readFileSync(file, "utf8"));
        fs.writeFileSync(file, JSON.stringify({ ...credentials, telemetry_disabled: true }));
      }
      fs.appendFileSync(process.env.TEST_SOURCE, JSON.stringify({ type: "response_item",
        payload: { type: "message", role: "user", content: "final overlapping turn" } }) + "\n");
      // The actual Stop hook runs after this worker has staged its snapshot.
      // No timing sleeps or retry-monitor sweep are used.
      const hook = cp.spawnSync(process.execPath, ["--require", __filename,
        path.join(process.env.PLUGIN_ROOT, "scripts/stop.js")], {
        cwd: process.cwd(), input: process.env.TEST_INPUT, encoding: "utf8", timeout: 5000,
        env: process.env,
      });
      if (hook.status !== 0 || hook.stdout.trim() !== "{}") throw Error("overlapping Stop failed: " + hook.stderr);
      record("requests.jsonl", fs.readFileSync(path.join(process.env.PLUGIN_DATA, "logs/.drain-once.request"), "utf8"));
    }
  };
  const unlink = fs.unlinkSync;
  fs.unlinkSync = file => {
    const result = unlink(file);
    if (process.env.TEST_INJECT === "release" && file === path.join(process.env.PLUGIN_DATA, "logs/.drain-once.lock")) injectStop();
    return result;
  };
  global.fetch = async (url, options) => {
    if (!String(url).startsWith("https://acme.meter.skillbench.ai/logs/codex")) throw Error("unexpected endpoint");
    const records = require("zlib").gunzipSync(options.body).toString().trim().split("\n").map(JSON.parse);
    record("uploads.jsonl", { url, records });
    const transcript = String(url).endsWith("/transcript");
    if (["transcript", "paused"].includes(process.env.TEST_INJECT) && transcript || process.env.TEST_INJECT === "event" && !transcript) injectStop();
    return { ok: process.env.TEST_STATUS === "200", status: Number(process.env.TEST_STATUS) };
  };
}

function fixture(t, inject = "transcript", status = 200) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-drain-handoff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo"), data = path.join(root, "data");
  const state = path.join(root, ".skillbench"), source = path.join(root, "rollout.jsonl");
  fs.mkdirSync(state);
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git/config"), '[remote "origin"]\nurl = https://github.com/acme/widgets.git\n');
  fs.mkdirSync(path.join(repo, ".codex"));
  fs.writeFileSync(path.join(repo, ".codex/settings.local.json"), '{"skillmeter":{"telemetry":true}}');
  const token = "h." + Buffer.from(JSON.stringify({ sub: "tenant", github_id: "synthetic", org: { login: "acme" }, exp: 4102444800,
    aud: "https://acme.meter.skillbench.ai" })).toString("base64url") + ".s";
  fs.writeFileSync(path.join(state, "credentials.json"), JSON.stringify({ device_id: "SYNTHETIC",
    hash_salt: "synthetic-salt", license_jwt: token, allowed_github_orgs: ["acme"] }));
  const input = { session_id: "synthetic", cwd: repo, transcript_path: source };
  const message = text => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: text } }) + "\n";
  fs.writeFileSync(source, JSON.stringify({ type: "session_meta", payload: { id: "synthetic", cwd: repo } }) + "\n");
  const preload = path.join(root, "preload.cjs");
  fs.writeFileSync(preload, "(" + preloadFixture.toString() + ")();\n");
  const env = { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, "codex"),
    PLUGIN_ROOT: plugin, PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PLUGIN_DATA: data,
    SKILLMETER_STATE_DIR: state, SKILLMETER_REPO_SCOPE_ORGS: "", SKILLMETER_BACKEND_URL: "",
    SKILLMETER_ACTIVATE_URL: "", NODE_OPTIONS: "", TEST_ROOT: root, TEST_SOURCE: source,
    TEST_INPUT: JSON.stringify(input), TEST_INJECT: inject || "none", TEST_STATUS: String(status) };
  function run(args, extra = {}) {
    const result = spawnSync(process.execPath, ["--require", preload, ...args], {
      cwd: repo, env: { ...env, ...extra }, input: JSON.stringify(input), encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return result;
  }
  const records = name => fs.existsSync(path.join(root, name)) ? fs.readFileSync(path.join(root, name), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  run(["-e", "require(" + JSON.stringify(path.join(plugin, "scripts/logger.js")) + ").requestTranscriptCapture(JSON.parse(process.env.TEST_INPUT))"]);
  fs.appendFileSync(source, message("first eligible turn"));
  const initial = run([path.join(plugin, "scripts/stop.js")]);
  assert.equal(records("spawns.jsonl").length, 1, initial.stderr);
  return { root, data, run, records, drain() {
    let count = 0;
    while (count < records("spawns.jsonl").length) {
      assert.ok(count < 4, "worker must not reschedule forever without new triggers");
      count++;
      run([path.join(plugin, "scripts/drain_once.js")]);
    }
    return count;
  } };
}

for (const phase of ["transcript", "event", "release"]) test("a final Stop at " + phase + " boundary drains without another hook or monitor", t => {
  const f = fixture(t, phase);
  f.drain();
  const uploads = f.records("uploads.jsonl");
  assert.deepEqual(uploads.filter(x => x.url.endsWith("/transcript")).flatMap(x => x.records)
    .filter(x => x.type === "response_item").map(x => x.payload.content), ["first eligible turn", "final overlapping turn"]);
  assert.equal(uploads.flatMap(x => x.records).filter(x => x.hook_event_name === "Stop").length, 2);
  assert.equal(fs.existsSync(path.join(f.data, "logs/.drain-once.lock")), false);
  assert.equal(fs.readFileSync(path.join(f.data, "logs/.drain-once.request"), "utf8"), f.records("requests.jsonl")[0],
    "worker handoff must not manufacture a new capture request");
});

test("a paused final hook cannot authorize a follow-up upload", t => {
  const f = fixture(t, "paused");
  assert.equal(f.drain(), 1);
  const records = f.records("uploads.jsonl").flatMap(x => x.records);
  assert.deepEqual(records.filter(x => x.type === "response_item").map(x => x.payload.content), ["first eligible turn"]);
  assert.equal(records.filter(x => x.hook_event_name === "Stop").length, 1);
});

test("new triggers during failed delivery cause only one additional pass", t => {
  const f = fixture(t, "transcript", 503);
  assert.equal(f.drain(), 2);
  assert.ok(fs.readdirSync(path.join(f.data, "logs")).some(name => /^events\.jsonl\.\d+$/.test(name)));
});

test("a successful drain without newer triggers schedules no successor", t => {
  const f = fixture(t, false);
  assert.equal(f.drain(), 1);
});

test("failed delivery without newer triggers stays queued instead of spawning a retry loop", t => {
  const f = fixture(t, false, 503);
  assert.equal(f.drain(), 1);
  assert.ok(fs.readdirSync(path.join(f.data, "logs")).some(name => /^events\.jsonl\.\d+$/.test(name)));
});

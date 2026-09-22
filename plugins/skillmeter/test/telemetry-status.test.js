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

function status({ seconds = 3600, credentials = {}, optedOut = false, queue = false, rejected = false, transcript = false, corrupt = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-status-"));
  roots.push(root);
  const repo = path.join(root, "repo"), data = path.join(root, "data"), state = path.join(root, ".skillbench");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git/config"), '[remote "origin"]\nurl = https://github.com/acme/widgets.git\n');
  fs.mkdirSync(state);
  const token = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds })).toString("base64url")}.s`;
  const store = JSON.stringify({ device_id: "synthetic-device", hash_salt: "synthetic-salt", license_jwt: token, allowed_github_orgs: ["acme"], ...credentials });
  const credentialPath = path.join(state, "credentials.json");
  fs.writeFileSync(credentialPath, store);
  if (optedOut) {
    fs.mkdirSync(path.join(repo, ".codex"));
    fs.writeFileSync(path.join(repo, ".codex/settings.local.json"), JSON.stringify({ skillmeter: { telemetry: false } }));
  }
  const logs = path.join(data, "logs");
  if (rejected) {
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, ".license-rejected"), "401\n");
  }
  if (transcript || corrupt) {
    const source = path.join(logs, "transcripts/chunks-v1", "a".repeat(64));
    const batch = path.join(source, "batch-1-abcd");
    fs.mkdirSync(batch, { recursive: true });
    fs.writeFileSync(path.join(source, "cursor.json"), corrupt ? "invalid json" : JSON.stringify({ baseline: 1 }));
    fs.writeFileSync(path.join(batch, "commit.json"), JSON.stringify({ cursor: { baseline: 1 }, chunks: [{ file: "chunk.gz" }] }));
    fs.writeFileSync(path.join(batch, "ready"), "1");
    fs.writeFileSync(path.join(batch, "chunk.gz"), "synthetic chunk");
  }
  if (queue) {
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, "events.jsonl.123"), "synthetic sealed event\n");
    fs.writeFileSync(path.join(logs, "events.jsonl"), "synthetic active event\n");
  }
  const preload = path.join(root, "preload.cjs");
  fs.writeFileSync(preload, `
global.fetch = () => { throw Error("status must not use network"); };
const cp = require("child_process");
cp.spawn = cp.execSync = () => { throw Error("status must not spawn or read Keychain"); };
`);
  const result = spawnSync(process.execPath, ["--require", preload, path.join(plugin, "scripts/telemetry.js"), "status"], {
    cwd: repo, encoding: "utf8", timeout: 5000,
    env: { ...process.env, HOME: root, USERPROFILE: root, PLUGIN_DATA: data, PLUGIN_ROOT: plugin,
      SKILLMETER_STATE_DIR: state, SKILLMETER_REPO_SCOPE_ORGS: "", NODE_OPTIONS: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(credentialPath, "utf8"), store, "status must not modify shared credentials");
  return result.stderr;
}

test("expiry pauses delivery without claiming scoped capture stopped", () => {
  const text = status({ seconds: -60, queue: true });
  assert.match(text, /Capture policy: eligible/);
  assert.match(text, /Delivery authentication: paused.*refresh/);
  assert.match(text, /1 sealed event batch.*0 transcript chunks/);
  assert.match(text, /Unsealed event data: present/);
  assert.doesNotMatch(text, /all events dropped|successfully uploaded/);
});

test("near-expiry credentials distinguish refresh due from delivery pause", () => {
  const text = status({ seconds: 120 });
  assert.match(text, /Delivery authentication: refresh due/);
  assert.doesNotMatch(text, /license expired|all events dropped/);
});

test("healthy credentials and empty queues do not claim delivery or hook health", () => {
  const text = status();
  assert.match(text, /eligible.*hook execution not verified/);
  assert.match(text, /0 sealed event batches.*0 transcript chunks/);
  assert.match(text, /Last successful upload: unknown/);
  assert.match(text, /empty queue does not prove delivery/);
});

test("project opt-out is reported independently of valid authentication", () => {
  const text = status({ optedOut: true });
  assert.match(text, /Capture policy: disabled for this project/);
  assert.match(text, /Delivery authentication: license locally valid/);
});

test("signed-out state does not use a leftover token to report delivery readiness", () => {
  const text = status({ credentials: { signed_out: true, telemetry_disabled: true, allowed_github_orgs: [] } });
  assert.match(text, /Capture policy: globally disabled/);
  assert.match(text, /Delivery authentication: signed out/);
});

test("missing credentials require sign-in without running migration", () => {
  const text = status({ credentials: { device_id: null, hash_salt: null, license_jwt: null, allowed_github_orgs: [] } });
  assert.match(text, /Delivery authentication: no license/);
});

test("server rejection overrides a locally unexpired license", () => {
  assert.match(status({ rejected: true }), /Delivery authentication: paused; server rejected/);
});

test("status includes pending transcript chunks alongside event batches", () => {
  assert.match(status({ queue: true, transcript: true }), /1 sealed event batch, 1 transcript chunks/);
});

test("unreadable queue state is unavailable rather than empty", () => {
  const text = status({ corrupt: true });
  assert.match(text, /Upload queue: unavailable/);
  assert.doesNotMatch(text, /0 transcript chunks/);
});

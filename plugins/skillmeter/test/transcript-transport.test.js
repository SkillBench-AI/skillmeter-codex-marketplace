"use strict";
// Only synthetic files/credentials. Never consult the user's Keychain or sessions.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-transport-"));
process.env.HOME = root; process.env.USERPROFILE = root; process.env.PLUGIN_DATA = path.join(root, "data");
delete process.env.SKILLMETER_REPO_SCOPE_ORGS;
delete process.env.SKILLMETER_BACKEND_URL;
const repo = path.join(root, "repo");
execFileSync("git", ["init", "--quiet", repo]);
execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/synthetic/repo.git"]);
const store = path.join(root, ".skillbench/credentials.json"); fs.mkdirSync(path.dirname(store));
const jwt = (sub = "synthetic-user", exp = 4102444800, extra = {}) => "e30." + Buffer.from(JSON.stringify({ sub, exp, aud: "https://synthetic.meter.skillbench.com", ...extra })).toString("base64url") + ".fixture";
const credentials = { device_id: "SYNTHETIC-DEVICE", hash_salt: "fixture-salt", license_jwt: jwt(), allowed_github_orgs: ["synthetic"] };
const save = patch => fs.writeFileSync(store, JSON.stringify({ ...credentials, ...patch }));
save({});
const logger = require("../scripts/logger");
const queue = require("../scripts/lib/transcript-delta");
const realFetch = global.fetch;
const source = path.join(root, "synthetic.jsonl");
const line = message => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: message } }) + "\n";
const stage = () => logger.stageTranscriptForUpload(source, { cwd: repo });
const upload = file => logger.processPendingTranscript(file, credentials.device_id, "https://collector.invalid/logs/codex", 1000);
beforeEach(() => {
  save({}); fs.rmSync(logger.LOG_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(repo, ".codex"), { recursive: true, force: true });
  fs.writeFileSync(source, line("synthetic first message"));
  global.fetch = async () => assert.fail("unexpected network attempt");
});
after(() => { global.fetch = realFetch; fs.rmSync(root, { recursive: true, force: true }); });

for (const [name, change] of [
  ["global disable", () => save({ telemetry_disabled: true })],
  ["signout", () => save({ signed_out: true })],
  ["org narrowing in another process", () => save({ allowed_github_orgs: [] })],
  ["changed user", () => save({ license_jwt: jwt("another-user") })],
  ["changed device", () => save({ device_id: "ANOTHER-DEVICE" })],
  ["expired token", () => save({ license_jwt: jwt("synthetic-user", 1) })],
  ["missing token", () => save({ license_jwt: "" })],
  ["project opt-out", () => { fs.mkdirSync(path.join(repo, ".codex")); fs.writeFileSync(path.join(repo, ".codex/settings.local.json"), '{"skillmeter":{"telemetry":false}}'); }],
]) test(`${name} blocks queued upload without consuming it`, async () => {
  const file = stage(); assert.ok(file); change();
  assert.equal(await upload(file), "skip"); assert.equal(fs.existsSync(file), true);
  assert.equal(stage(), null);
});

test("token refresh for the same principal resumes pending chunks", async () => {
  const file = stage(); save({ license_jwt: jwt("synthetic-user", 4102444800, { jti: "rotated" }) });
  global.fetch = async (_, options) => { assert.equal(options.headers.Authorization, `Bearer ${jwt("synthetic-user", 4102444800, { jti: "rotated" })}`); return { ok: true }; };
  assert.equal(await upload(file), "sent"); assert.equal(fs.existsSync(file), false);
});

for (const status of [400, 401, 403, 413, 429, 500]) test(`HTTP ${status} retains chunk and credentials without anonymous retry`, async () => {
  const file = stage(), before = fs.readFileSync(store); let calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status }; };
  await upload(file); assert.equal(calls, 1); assert.equal(fs.existsSync(file), true);
  assert.deepEqual(fs.readFileSync(store), before);
});

test("scope is rechecked between each ordered chunk", async () => {
  const file = stage(); fs.appendFileSync(source, line("second")); stage(); let calls = 0;
  global.fetch = async () => { calls++; save({ allowed_github_orgs: [] }); return { ok: true }; };
  await upload(file); assert.equal(calls, 1); assert.equal(logger.listPendingTranscripts().length, 1);
});

test("raw turn-context scope prevents an old capture hint from collecting a moved session", () => {
  fs.writeFileSync(source, JSON.stringify({type: "session_meta", payload: {cwd: repo, id: "synthetic"}}) + "\n" + line("allowed"));
  assert.ok(stage());
  fs.appendFileSync(source, JSON.stringify({type: "turn_context", payload: {cwd: root}}) + "\n" + line("out of scope"));
  assert.equal(stage(), null);
  const pending = logger.listPendingTranscripts(); assert.equal(pending.length, 1);
  const diagnostic = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(pending[0])), "diagnostic.json")));
  assert.equal(diagnostic.code, "source-scope-changed");
});

test("legacy snapshots remain untouched and never enter the sequenced queue", async () => {
  fs.mkdirSync(logger.TRANSCRIPTS_PENDING_DIR, { recursive: true });
  const legacy = path.join(logger.TRANSCRIPTS_PENDING_DIR, "legacy.jsonl"); fs.writeFileSync(legacy, line("retained"));
  const before = fs.readFileSync(legacy);
  assert.equal(await upload(legacy), "skip");
  assert.deepEqual(logger.listPendingTranscripts(), []); assert.deepEqual(fs.readFileSync(legacy), before);
});

for (const event of ["session_end", "interrupt"]) test(`${event} saves a hint under three seconds without reading transcript or doing network`, () => {
  const preload = path.join(root, "preload.cjs"), marker = path.join(root, "spawned");
  fs.writeFileSync(preload, `const fs=require('node:fs'); const read=fs.readFileSync; fs.readFileSync=function(p,...args){if(p===${JSON.stringify(source)})throw Error('hook read raw transcript');return read.call(this,p,...args)}; require('node:child_process').spawn=()=>{fs.writeFileSync(${JSON.stringify(marker)},'spawned');return {pid:123,unref(){}}};global.fetch=()=>{throw Error('hook network')};`);
  const start = Date.now();
  const result = spawnSync(process.execPath, ["--require", preload, path.join(__dirname, "../scripts", event + ".js")], {
    cwd: repo, env: process.env, input: JSON.stringify({ session_id: "synthetic", transcript_path: source, cwd: repo, reason: "other", turn_id: "synthetic-turn" }), encoding: "utf8", timeout: 3000,
  });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), {});
  assert.ok(Date.now() - start < 3000); assert.equal(fs.existsSync(marker), true);
  assert.equal(fs.readdirSync(logger.TRANSCRIPT_CAPTURES_DIR).filter(n => n.endsWith(".json")).length, 1);
  assert.equal(logger.listPendingTranscripts().length, 0);
});

test("shutdown fallback uses the cached session path without scanning the sessions tree", () => {
  assert.equal(logger.requestTranscriptCapture({ cwd: repo, session_id: "cached", transcript_path: source }), 1);
  assert.equal(logger.requestTranscriptCapture({ cwd: repo, session_id: "cached" }, { discover: false }), 1);
  logger.stageRequestedTranscripts(); assert.equal(logger.listPendingTranscripts().length, 1);
});

test("cleanup and dry-run inventory preserve old transcript copies", () => {
  const pending = path.join(logger.TRANSCRIPTS_PENDING_DIR, "old.jsonl");
  const poison = path.join(logger.POISON_DIR, "old.jsonl");
  for (const file of [pending, poison]) { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, line("old synthetic")); fs.utimesSync(file, new Date(0), new Date(0)); }
  const before = [pending, poison].map(f => fs.readFileSync(f));
  logger.cleanupStaleFiles();
  const result = require("../scripts/transcript_inventory").inventory(process.env.PLUGIN_DATA);
  assert.deepEqual(result, {dryRun:true,legacyPending:1,legacyPoisonUnknownReason:1,chunkDiagnostics:{}});
  assert.deepEqual([pending, poison].map(f => fs.readFileSync(f)), before);
});

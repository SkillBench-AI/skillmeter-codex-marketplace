"use strict";

// Exercise real queue/control code with synthetic state. No hooks, daemon,
// credentials from the host, or network.
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-revocation-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.PLUGIN_DATA = path.join(root, "data");
delete process.env.SKILLMETER_REPO_SCOPE_ORGS;
delete process.env.SKILLMETER_BACKEND_URL;
const store = path.join(root, ".skillbench/credentials.json");
fs.mkdirSync(path.dirname(store), { recursive: true });
const token = "e30." + Buffer.from(JSON.stringify({
  sub: "synthetic-tenant", github_id: "synthetic-user", exp: 4102444800,
  aud: "https://synthetic.meter.skillbench.com",
})).toString("base64url") + ".fixture";
const credentials = {
  device_id: "SYNTHETIC", hash_salt: "synthetic-salt", license_jwt: token,
  allowed_github_orgs: ["synthetic"],
};
fs.writeFileSync(store, JSON.stringify(credentials));
const logger = require("../scripts/logger");
const queue = require("../scripts/lib/transcript-delta");
const realFetch = global.fetch;
const endpoint = "https://collector.invalid/logs/codex";
const repos = Object.fromEntries(["a", "b"].map(name => {
  const directory = path.join(root, name);
  execFileSync("git", ["init", "--quiet", directory]);
  execFileSync("git", ["-C", directory, "remote", "add", "origin", `https://github.com/synthetic/${name}.git`]);
  return [name, directory];
}));
const decode = body => zlib.gunzipSync(body).toString().trim().split("\n").map(JSON.parse);
const line = content => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content } }) + "\n";
const source = name => path.join(root, `${name}.jsonl`);

function control(name, action) {
  execFileSync(process.execPath, [path.resolve(__dirname, "../scripts/telemetry.js"), action], {
    cwd: repos[name], env: process.env, stdio: "pipe", timeout: 5000,
  });
}

function stage(name, content = `authorized-${name}`) {
  fs.appendFileSync(source(name), line(content));
  const file = logger.stageTranscriptForUpload(source(name), { cwd: repos[name] });
  assert.ok(file, "fixture must stage a real authorized chunk");
  return file;
}

function event(name) {
  // Match the current event's hashed repository fields; do not add a proposed
  // routing field that the actual producer does not yet write.
  logger.logInfo("Stop", `synthetic-${name}`, {
    cwd: logger.hashHmac(repos[name], credentials.hash_salt),
    repo_root: logger.hashHmac(repos[name], credentials.hash_salt),
    repo_remote_org: logger.hashHmac("synthetic", credentials.hash_salt),
  }, credentials.device_id);
}

beforeEach(() => {
  fs.writeFileSync(store, JSON.stringify(credentials));
  fs.rmSync(logger.LOG_DIR, { recursive: true, force: true });
  for (const name of ["a", "b"]) {
    logger.saveTelemetryOptIn(repos[name], true);
    fs.writeFileSync(source(name), "");
    logger.observeTranscriptConsent(source(name), repos[name]);
  }
  global.fetch = async () => assert.fail("unexpected network attempt");
});
after(() => {
  global.fetch = realFetch;
  fs.rmSync(root, { recursive: true, force: true });
});

test("disabling A preserves B's pending chunk and cursor byte for byte", () => {
  stage("a");
  const b = stage("b");
  const cursor = path.join(path.dirname(path.dirname(b)), "cursor.json");
  const before = [b, cursor].map(file => fs.readFileSync(file));
  control("a", "disable");
  assert.deepEqual([b, cursor].map(file => fs.readFileSync(file)), before);
});

test("transcript drain rechecks disabled A while delivering authorized B", async () => {
  stage("a"); stage("b");
  control("a", "disable");
  const received = [];
  global.fetch = async (_, options) => { received.push(...decode(options.body)); return { ok: true }; };
  await logger.drainPendingTranscripts(endpoint, 1000);
  assert.deepEqual(received.map(record => record.payload.content), ["authorized-b"]);
});

test("revocation after a request starts cannot undo it but blocks the next chunk", async () => {
  stage("a", "first"); stage("a", "second");
  const received = [];
  global.fetch = async (_, options) => {
    received.push(...decode(options.body));
    control("a", "disable");
    return { ok: true };
  };
  await logger.drainPendingTranscripts(endpoint, 1000);
  assert.deepEqual(received.map(record => record.payload.content), ["first"]);
});

test("global pause retains sealed events and transcript bytes without sending", async () => {
  const chunks = [stage("a"), stage("b")];
  event("a"); event("b");
  const sealed = logger.sealEventLog();
  const files = [sealed, ...chunks];
  const before = files.map(file => fs.readFileSync(file));
  logger.setTelemetryGloballyDisabled(true);
  assert.equal(await logger.drainQueuesOnce(endpoint, 1000), 0);
  assert.deepEqual(files.map(file => fs.readFileSync(file)), before);
});

test("repository disable does not guess ownership or destroy an unattributed legacy batch", () => {
  fs.mkdirSync(logger.LOG_DIR, { recursive: true });
  const legacy = path.join(logger.LOG_DIR, `events.jsonl.${Date.now()}`);
  const bytes = '{"hook_event_name":"Stop","data":{"fixture":"unknown-repository"}}\n';
  fs.writeFileSync(legacy, bytes);
  control("a", "disable");
  assert.equal(fs.readFileSync(legacy, "utf8"), bytes);
  // Delivery/quarantine/migration of this batch is intentionally undecided.
});

test("repository revocation removes A's queued transcript payloads but preserves its cursor",
  () => {
    const a = stage("a");
    const b = stage("b");
    const cursor = path.join(path.dirname(path.dirname(a)), "cursor.json");
    const before = fs.readFileSync(cursor);
    control("a", "disable");
    assert.ok(fs.existsSync(b), "unrelated repository must survive revocation");
    assert.deepEqual(fs.readFileSync(cursor), before, "cursor must survive payload removal");
    assert.equal(fs.existsSync(a), false, "revoked payload must be removed");
  });

test("mixed event batch delivers B without disclosing disabled A",
  async () => {
    event("a"); event("b");
    const sealed = logger.sealEventLog();
    control("a", "disable");
    const received = [];
    global.fetch = async (_, options) => { received.push(...decode(options.body)); return { ok: true }; };
    await logger.processSealedBatch(sealed, endpoint, 1000);
    assert.deepEqual(received.map(record => record.session_id), ["synthetic-b"]);
  });

test("a failed event delivery rechecks repository consent before retrying",
  async () => {
    event("a");
    const sealed = logger.sealEventLog();
    let calls = 0;
    global.fetch = async () => { calls++; return { ok: false, status: 503 }; };
    assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "retry");
    control("a", "disable");
    await logger.processSealedBatch(sealed, endpoint, 1000);
    assert.equal(calls, 1, "a revoked repository cannot be sent again");
  });


test("private routing stays local and authorized B survives an in-flight A revocation", async () => {
  event("a"); event("b");
  const sealed = logger.sealEventLog();
  let sent;
  global.fetch = async (_, options) => {
    sent = decode(options.body);
    control("a", "disable");
    control("a", "enable");
    return { ok: false, status: 503 };
  };
  await logger.processSealedBatch(sealed, endpoint, 1000);
  assert.equal(sent.length, 2, "the request had already started");
  assert.ok(sent.every(record => !Object.hasOwn(record, "_queue")));
  global.fetch = async (_, options) => { sent = decode(options.body); return { ok: true }; };
  await logger.processSealedBatch(sealed, endpoint, 1000);
  assert.deepEqual(sent.map(record => record.session_id), ["synthetic-b"]);
});

test("disable/re-enable during a transcript request purges remaining revoked payloads", async () => {
  stage("a", "first"); const pending = stage("a", "second");
  let calls = 0;
  global.fetch = async () => {
    calls++;
    control("a", "disable"); control("a", "enable");
    return { ok: false, status: 503 };
  };
  await logger.drainPendingTranscripts(endpoint, 1000);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(pending), false);
  assert.equal(logger.listPendingTranscripts().length, 0);
  logger.observeTranscriptConsent(source("a"), repos.a);
  stage("a", "new authorization");
  let received;
  global.fetch = async (_, options) => { received = decode(options.body); return { ok: true }; };
  await logger.drainPendingTranscripts(endpoint, 1000);
  assert.deepEqual(received.map(record => record.payload.content), ["new authorization"]);
});

test("new indexed events with missing routing state are retained without delivery or retry charge", async () => {
  event("a"); const sealed = logger.sealEventLog();
  fs.rmSync(path.join(logger.LOG_DIR, "repository-routing"), { recursive: true });
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "held");
  assert.ok(fs.existsSync(sealed));
  assert.equal(fs.existsSync(`${sealed}.meta`), false);
});

test("explicit revocation during global pause removes only the selected repository", () => {
  const a = stage("a"), b = stage("b");
  event("a"); event("b"); const sealed = logger.sealEventLog();
  logger.setTelemetryGloballyDisabled(true);
  control("a", "disable");
  assert.equal(fs.existsSync(a), false);
  assert.ok(fs.existsSync(b));
  assert.deepEqual(fs.readFileSync(sealed, "utf8").trim().split("\n").map(JSON.parse).map(r => r.session_id), ["synthetic-b"]);
});


test("corrupt routing retains payload without network or a retry charge", async () => {
  event("a"); const sealed = logger.sealEventLog();
  const routing = path.join(logger.LOG_DIR, "repository-routing");
  for (const file of fs.readdirSync(routing)) fs.writeFileSync(path.join(routing, file), "{}");
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "held");
  assert.ok(fs.existsSync(sealed));
  assert.equal(fs.existsSync(`${sealed}.meta`), false);
});


test("a symlink checkout alias shares the revocation boundary", () => {
  const alias = path.join(root, "alias-a");
  fs.symlinkSync(repos.a, alias, "dir");
  logger.saveTelemetryOptIn(alias, true);
  logger.observeTranscriptConsent(source("a"), repos.a);
  logger.logInfo("Stop", "alias-event", {
    cwd: logger.hashHmac(alias, credentials.hash_salt),
    repo_root: logger.hashHmac(alias, credentials.hash_salt),
  }, credentials.device_id);
  const sealed = logger.sealEventLog();
  const chunk = stage("a");
  control("a", "disable");
  assert.equal(fs.existsSync(sealed), false);
  assert.equal(fs.existsSync(chunk), false);
});

test("a hook at the disable settings-write boundary cannot inherit the revoked generation", async () => {
  const settings = path.join(repos.a, logger.SETTINGS_RELATIVE);
  const write = fs.writeFileSync, rename = fs.renameSync;
  let snapshot, injected = false;
  const intercept = () => {
    if (injected) return;
    injected = true;
    // The child runs the hook's actual register + consent check while the
    // control process is paused immediately before publishing its setting.
    snapshot = JSON.parse(execFileSync(process.execPath, ["-e", `
      const logger = require(process.argv[1]);
      const { createRepositoryQueue } = require(process.argv[2]);
      const cwd = process.argv[3];
      const routing = createRepositoryQueue(logger.LOG_DIR, logger.getOrCreateHashSalt, () => true);
      try {
        const route = routing.register(cwd, logger.findGitRoot(cwd));
        const allowed = logger.resolveTelemetryGate(logger.getTelemetryOptIn(cwd), logger.getRepoScopeDecision(cwd).allowed).capture;
        if (allowed) {
          logger.observeTranscriptConsent(process.argv[4], cwd);
          require("fs").appendFileSync(process.argv[4], JSON.stringify({type:"response_item",payload:{type:"message",role:"user",content:"transition transcript"}}) + "\\n");
          logger.stageTranscriptForUpload(process.argv[4], { cwd });
        }
        process.stdout.write(JSON.stringify(allowed ? { epoch: route.epoch } : null));
      } catch (error) {
        if (error.message !== "repository-routing-busy") throw error;
        process.stdout.write("null");
      }
    `, path.resolve(__dirname, "../scripts/logger.js"), path.resolve(__dirname, "../scripts/lib/repository-queue.js"), repos.a, source("a")],
    { env: process.env, encoding: "utf8", timeout: 5000 }));
  };
  fs.writeFileSync = function(file, ...args) {
    if (file === settings) intercept();
    return write.call(this, file, ...args);
  };
  fs.renameSync = function(from, to) {
    if (to === settings) intercept();
    return rename.call(this, from, to);
  };
  try { logger.saveTelemetryOptIn(repos.a, false); }
  finally { fs.writeFileSync = write; fs.renameSync = rename; }
  assert.equal(injected, true, "must exercise the settings publication boundary");
  if (snapshot) {
    logger.logInfo("Stop", "late-hook", {
      cwd: logger.hashHmac(repos.a, credentials.hash_salt),
      repo_root: logger.hashHmac(repos.a, credentials.hash_salt),
    }, credentials.device_id, snapshot);
  }
  control("a", "enable");
  const sealed = logger.sealEventLog(), received = [];
  global.fetch = async (_, options) => { received.push(...decode(options.body)); return { ok: true }; };
  if (sealed) await logger.processSealedBatch(sealed, endpoint, 1000);
  await logger.drainPendingTranscripts(endpoint, 1000);
  assert.deepEqual(received, [], "re-enable cannot resurrect a hook or transcript admitted during disable");
});

test("temporary missing organization authorization retains events for recovery", async () => {
  event("a"); const sealed = logger.sealEventLog(), bytes = fs.readFileSync(sealed);
  fs.writeFileSync(store, JSON.stringify({ ...credentials, allowed_github_orgs: [] }));
  let blockedCalls = 0;
  global.fetch = async () => { blockedCalls++; return { ok: false, status: 503 }; };
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "held");
  assert.equal(blockedCalls, 0);
  assert.deepEqual(fs.readFileSync(sealed), bytes);
  fs.writeFileSync(store, JSON.stringify(credentials));
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: true }; };
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "sent");
  assert.equal(calls, 1);
});


test("missing credentials retain queued events without an upload or retry charge", async () => {
  event("a"); const sealed = logger.sealEventLog(), bytes = fs.readFileSync(sealed);
  fs.writeFileSync(store, JSON.stringify({ device_id: credentials.device_id, hash_salt: credentials.hash_salt }));
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status: 503 }; };
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "auth");
  assert.equal(calls, 0);
  assert.deepEqual(fs.readFileSync(sealed), bytes);
  assert.equal(fs.existsSync(`${sealed}.meta`), false);
});

test("revocation removes A even when B's delivery authorization is temporarily unavailable", () => {
  event("a"); event("b"); const sealed = logger.sealEventLog();
  fs.writeFileSync(path.join(repos.b, logger.SETTINGS_RELATIVE), "{}");
  control("a", "disable");
  assert.deepEqual(fs.readFileSync(sealed, "utf8").trim().split("\n").map(JSON.parse).map(r => r.session_id), ["synthetic-b"]);
});

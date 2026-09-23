"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const queue = require("../scripts/lib/transcript-delta");
const scope = { deviceId: "SYNTHETIC", owner: "fixture-owner", consentStamp: "synthetic-consent", cwd: "/synthetic", org: "synthetic" };
const salt = "synthetic-salt";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-chunks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "rollout.jsonl"), root = path.join(dir, "queue");
  const stage = opts => queue.stage(root, source, scope, salt, opts);
  const records = files => files.flatMap(f => zlib.gunzipSync(fs.readFileSync(f)).toString().trim().split("\n").map(JSON.parse));
  return { dir, source, root, stage, records };
}
const line = value => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: value } }) + "\n";

test("consent byte ranges exclude pre-opt-in and paused content even in full-baseline recovery", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, line("before opt-in"));
  const observe = enabled => queue.observeConsent(f.root, f.source, scope, salt, enabled, "synthetic-consent");
  observe(true);
  fs.appendFileSync(f.source, line("authorized first"));
  const first = f.stage({ consent: observe(true) });
  assert.deepEqual(f.records(first.files).map(r => r.payload.content), ["authorized first"]);
  const dir = queue.queueDirectories(f.root)[0];
  await queue.drainDirectory(dir, async () => "sent");
  observe(false);
  fs.appendFileSync(f.source, line("while paused"));
  observe(false);
  observe(true);
  fs.appendFileSync(f.source, line("authorized second"));
  f.stage({ consent: observe(true) });
  await queue.drainDirectory(dir, async () => "reset-required");
  const reset = f.stage({ consent: observe(true) });
  assert.deepEqual(f.records(reset.files).map(r => r.payload.content), ["authorized first", "authorized second"]);
});

test("a partial line crossing the initial consent boundary is excluded whole", t => {
  const f = fixture(t), record = line("partly before opt-in");
  fs.writeFileSync(f.source, record.slice(0, 30));
  queue.observeConsent(f.root, f.source, scope, salt, true, "consent");
  fs.appendFileSync(f.source, record.slice(30) + line("authorized"));
  const consent = queue.observeConsent(f.root, f.source, scope, salt, true, "consent");
  assert.deepEqual(f.records(f.stage({ consent }).files).map(r => r.payload.content), ["authorized"]);
});

test("source rewrite cannot reuse consent byte offsets during a server reset", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, "");
  queue.observeConsent(f.root, f.source, scope, salt, true, "consent");
  fs.appendFileSync(f.source, line("authorized"));
  const consent = queue.observeConsent(f.root, f.source, scope, salt, true, "consent");
  f.stage({ consent });
  await queue.drainDirectory(queue.queueDirectories(f.root)[0], async () => "reset-required");
  fs.writeFileSync(f.source, line("replacement history has no authorization"));
  assert.throws(() => f.stage({ consent }), /consent-source-rewritten/);
});

test("corrupt consent offsets cannot stage or silently re-authorize history", t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, line("historical"));
  queue.observeConsent(f.root, f.source, scope, salt, true, "consent");
  const file = path.join(queue.queueDirectories(f.root)[0], "consent.json");
  const state = JSON.parse(fs.readFileSync(file));
  state.excluded = [[-1, state.observed]];
  fs.writeFileSync(file, JSON.stringify(state));
  assert.throws(() => queue.observeConsent(f.root, f.source, scope, salt, true, "consent"), /invalid-consent-journal/);
  assert.throws(() => f.stage({consent:state}), /invalid-consent-journal/);
  assert.deepEqual(queue.pendingFiles(f.root), []);
});
test("a consent change during staging cannot publish a cursor or payload", t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, line("synthetic"));
  assert.throws(() => f.stage({authorizeCommit:() => false}), /consent-changed-during-stage/);
  const dir = queue.queueDirectories(f.root)[0];
  assert.equal(fs.existsSync(path.join(dir, "cursor.json")), false);
  assert.equal(fs.readdirSync(dir).some(name => name.startsWith("batch-")), false);
});


test("a stale or disabled consent snapshot cannot publish new chunks", t => {
  const f=fixture(t); fs.writeFileSync(f.source, "");
  const consent=queue.observeConsent(f.root,f.source,scope,salt,true,"consent");
  fs.appendFileSync(f.source,line("late record"));
  const disabled=queue.observeConsent(f.root,f.source,scope,salt,false,"consent");
  assert.throws(()=>f.stage({consent}),/consent-changed-during-stage/);
  assert.throws(()=>f.stage({consent:disabled}),/consent-changed-during-stage/);
  assert.deepEqual(queue.pendingFiles(queue.queueDirectories(f.root)[0]),[]);
});

test("bytes appended after authorization observation wait for another observation", t => {
  const f=fixture(t);fs.writeFileSync(f.source,"");
  queue.observeConsent(f.root,f.source,scope,salt,true,"consent");
  fs.appendFileSync(f.source,line("authorized"));
  const consent=queue.observeConsent(f.root,f.source,scope,salt,true,"consent");
  fs.appendFileSync(f.source,line("not yet observed"));
  assert.deepEqual(f.records(f.stage({consent}).files).map(r=>r.payload.content),["authorized"]);
});

test("revocation just before publication leaves no visible payload or cursor", t => {
  const f=fixture(t);fs.writeFileSync(f.source,line("synthetic"));let allowed=true;
  assert.throws(()=>f.stage({authorizeCommit:()=>allowed,fault:point=>{if(point==="before-publish")allowed=false;}}),/consent-changed-during-stage/);
  const dir=queue.queueDirectories(f.root)[0];
  assert.equal(fs.existsSync(path.join(dir,"cursor.json")),false);
  assert.deepEqual(queue.pendingFiles(dir),[]);
});

test("excluded history longer than a stage budget does not strand authorized data", t => {
  const f=fixture(t);fs.writeFileSync(f.source,line("old "+"x".repeat(1000)));
  queue.observeConsent(f.root,f.source,scope,salt,true,"consent");
  fs.appendFileSync(f.source,line("authorized"));
  const consent=queue.observeConsent(f.root,f.source,scope,salt,true,"consent");
  assert.deepEqual(f.records(f.stage({consent,stageBytes:100}).files).map(r=>r.payload.content),["authorized"]);
});

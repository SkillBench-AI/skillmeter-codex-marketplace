"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const queue = require("../scripts/lib/transcript-delta");
const salt = "synthetic-startup-salt";
const scope = {deviceId:"SYNTHETIC", owner:"synthetic-owner", consentStamp:"synthetic-consent"};
const encode = record => JSON.stringify(record) + "\n";
const message = text => ({type:"response_item", payload:{type:"message", role:"user", content:text}});

function setup(t, metadata = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-startup-"));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const source = path.join(root, "rollout.jsonl"), queues = path.join(root, "queue");
  const header = {type:"session_meta", uuid:"synthetic-source-record", timestamp:"2026-09-14T00:00:00Z", payload:{
    id:"synthetic-session", cwd:"/synthetic/repo", source:"cli",
    instructions:"EXCLUDED-INSTRUCTIONS", extra:{secret:"EXCLUDED-EXTRA"}, ...metadata,
  }};
  fs.writeFileSync(source, [header, {type:"event_msg", payload:{type:"task_started"}},
    {type:"response_item", payload:{type:"message", role:"developer", content:"EXCLUDED-DEVELOPER"}},
    message("EXCLUDED-HISTORY"), {type:"world_state", payload:{content:"EXCLUDED-WORLD"}},
    {type:"turn_context", payload:{cwd:"/synthetic/repo"}},
  ].map(encode).join(""));
  const observe = enabled => queue.observeConsent(queues, source, scope, salt, enabled, "synthetic-consent");
  observe(true);
  fs.appendFileSync(source, encode(message("authorized first")));
  const stage = options => queue.stage(queues, source, scope, salt, {
    consent:observe(true), preserveSessionMetadata:true,
    authorizeRecord: record => !record.payload?.cwd || record.payload.cwd === "/synthetic/repo", ...options,
  });
  const records = result => result.files.flatMap(file => zlib.gunzipSync(fs.readFileSync(file)).toString().trim().split("\n").map(JSON.parse));
  return {source, queues, observe, stage, records};
}

test("a startup header preserves identity and hashed workspace without reopening the consent prefix", t => {
  const f = setup(t), result = f.stage(), records = f.records(result);
  assert.equal(records[0].type, "session_meta");
  assert.equal(records[0].payload.id, "synthetic-session");
  assert.equal(records[0].payload.cwd, queue.hmac(salt, "/synthetic/repo").slice(0, 12));
  assert.equal(records[0].payload.source, "cli");
  assert.equal(records[0]._codex_source_uuid, "synthetic-source-record");
  assert.deepEqual(Object.keys(records[0].payload).sort(), ["cwd", "id", "source"]);
  assert.equal(records[1].payload.content, "authorized first");
  assert.equal(records.length, 2);
  assert.ok(!JSON.stringify(records).includes("EXCLUDED-"));
  assert.equal(f.stage().status, "unchanged");
});

test("the header passes the same repository authorization as captured records", t => {
  const f = setup(t, {cwd:"/synthetic/other"});
  assert.throws(() => f.stage(), /source-scope-changed/);
  assert.equal(queue.queueDirectories(f.queues).flatMap(queue.pendingFiles).length, 0);
});

test("subagent lineage survives the minimal header without copying nested instructions", t => {
  const f = setup(t, {parent_thread_id:"synthetic-parent", source:{subagent:{instructions:"EXCLUDED-CHILD"}}});
  const header = f.records(f.stage())[0];
  assert.equal(header.payload.parent_thread_id, "synthetic-parent");
  assert.deepEqual(header.payload.source, {subagent:true});
  assert.ok(!JSON.stringify(header).includes("EXCLUDED-"));
});

test("an unrecognized structured source fails closed instead of hiding possible lineage", t => {
  const f = setup(t, {source:{future_agent:{parent:"synthetic-parent"}}});
  assert.throws(() => f.stage(), /unsupported-session-source/);
});

test("upgrading an existing cursor resets monotonically and still excludes paused content", t => {
  const f = setup(t);
  const legacy = f.stage({preserveSessionMetadata:false});
  assert.equal(f.records(legacy).length, 1);
  f.observe(false);
  fs.appendFileSync(f.source, encode(message("EXCLUDED-PAUSED")));
  f.observe(false); f.observe(true);
  fs.appendFileSync(f.source, encode(message("authorized resumed")));
  const upgraded = f.stage(), records = f.records(upgraded);
  assert.equal(upgraded.cursor.baseline, legacy.cursor.seq + 1);
  assert.equal(upgraded.cursor.generation, legacy.cursor.generation + 1);
  assert.deepEqual(records.map(r => r.type), ["session_meta", "response_item", "response_item"]);
  assert.ok(!JSON.stringify(records).includes("EXCLUDED-"));
  assert.equal(f.stage().status, "unchanged");
});

test("consent revoked before commit prevents even the metadata-only prefix from publishing", t => {
  const f = setup(t);
  assert.throws(() => f.stage({authorizeCommit:() => false}), /consent-changed-during-stage/);
  assert.equal(queue.queueDirectories(f.queues).flatMap(queue.pendingFiles).length, 0);
});

test("a crash after publishing the header recovers one snapshot without duplicate records", t => {
  const f = setup(t);
  assert.throws(() => f.stage({fault: point => { if (point === "after-publish") throw Error("synthetic crash"); }}));
  assert.equal(f.stage().status, "unchanged");
  const files = queue.queueDirectories(f.queues).flatMap(queue.pendingFiles);
  const records = f.records({files});
  assert.equal(records.length, 2);
  assert.equal(records.filter(record => record.type === "session_meta").length, 1);
});

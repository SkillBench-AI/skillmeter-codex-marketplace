"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const queue = require("../scripts/lib/transcript-delta");
const scope = { deviceId: "SYNTHETIC", owner: "fixture-owner", consentStamp: "synthetic-consent", cwd: "/synthetic", org: "synthetic" };
const salt = "synthetic-salt";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-chunks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "rollout.jsonl"), root = path.join(dir, "queue");
  const consent = () => queue.observeConsent(root, source, scope, salt, true, "synthetic-consent");
  const stage = opts => queue.stage(root, source, scope, salt, { consent: consent(), preserveSessionMetadata: true, ...opts });
  const records = files => files.flatMap(f => zlib.gunzipSync(fs.readFileSync(f)).toString().trim().split("\n").map(JSON.parse));
  // The startup record is written before opt-in, as in a live session.
  const start = first => { fs.writeFileSync(source, first); consent(); };
  return { dir, source, root, stage, records, start };
}
const meta = JSON.stringify({ type: "session_meta", timestamp: "2026-09-01T00:00:00.000Z", payload: {
  id: "thread-1", cwd: "/synthetic", originator: "codex_cli_rs", instructions: "private startup context", cli_version: "0.1.0" } }) + "\n";
const line = value => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: value } }) + "\n";

test("continuation identity survives a startup record spanning multiple read buffers", t => {
  const f = fixture(t);
  const header = JSON.parse(meta);
  header.payload.instructions = "private startup context ".repeat(10000);
  header.payload.parent_thread_id = "parent-at-end";
  f.start(JSON.stringify(header) + "\n");
  fs.appendFileSync(f.source, line("first"));
  const first = f.records(f.stage().files)[0];
  fs.appendFileSync(f.source, line("second"));
  const later = f.records(f.stage().files);
  assert.deepEqual(later.map(r => r.type), ["session_continuation", "response_item"]);
  assert.deepEqual(later[0].payload, first.payload);
  assert.equal(later[0].payload.parent_thread_id, "parent-at-end");
  assert.equal(later[1].payload.content, "second");
  assert.ok(!JSON.stringify(later).includes("private startup context"));
});

test("batches staged past the file start open with the session's routing identity", t => {
  const f = fixture(t);
  f.start(meta);
  fs.appendFileSync(f.source, line("first"));
  const first = f.records(f.stage().files);
  assert.deepEqual(first.map(r => r.type), ["session_meta", "response_item"]);
  fs.appendFileSync(f.source, line("second"));
  const second = f.records(f.stage().files);
  assert.deepEqual(second.map(r => r.type), ["session_continuation", "response_item"]);
  const [header] = first, [continuation] = second;
  assert.deepEqual(Object.keys(continuation.payload).sort(), ["cwd", "id", "originator"]);
  assert.equal(continuation.payload.id, header.payload.id);
  assert.equal(continuation.payload.cwd, header.payload.cwd);
  assert.equal(continuation.timestamp, undefined);
  assert.ok(!JSON.stringify(second).includes("private startup context"));
  fs.appendFileSync(f.source, line("third"));
  const third = f.records(f.stage().files);
  assert.equal(third[0].type, "session_continuation");
  assert.equal(third[0].uuid, continuation.uuid);
  assert.notEqual(third[0].uuid, header.uuid);
});

test("identity never ships alone, and only when session metadata is preserved", t => {
  const f = fixture(t);
  f.start(meta);
  fs.appendFileSync(f.source, line("first"));
  f.stage();
  assert.equal(f.stage().status, "unchanged");
  fs.appendFileSync(f.source, line("second"));
  assert.deepEqual(f.records(f.stage({ preserveSessionMetadata: false }).files).map(r => r.type), ["response_item"]);
});

test("a source whose first record is not session_meta stays content-only", t => {
  const f = fixture(t);
  f.start(line("before opt-in"));
  fs.appendFileSync(f.source, line("first"));
  f.stage();
  fs.appendFileSync(f.source, line("second"));
  assert.deepEqual(f.records(f.stage().files).map(r => r.payload.content), ["second"]);
});

test("a reset restarts from the first record; later batches carry the new generation's identity", async t => {
  const f = fixture(t);
  f.start(meta);
  fs.appendFileSync(f.source, line("first"));
  f.stage();
  fs.appendFileSync(f.source, line("second"));
  const previous = f.records(f.stage().files)[0];
  const dir = queue.queueDirectories(f.root)[0];
  await queue.drainDirectory(dir, async () => "reset-required");
  const reset = f.records(f.stage().files);
  assert.deepEqual(reset.map(r => r.type), ["session_meta", "response_item", "response_item"]);
  fs.appendFileSync(f.source, line("third"));
  const next = f.records(f.stage().files)[0];
  assert.equal(next.type, "session_continuation");
  assert.notEqual(next.uuid, previous.uuid);
});

test("the continuation is authorized like the first record", t => {
  const f = fixture(t);
  f.start(meta);
  fs.appendFileSync(f.source, line("first"));
  f.stage();
  fs.appendFileSync(f.source, line("second"));
  assert.throws(() => f.stage({ authorizeRecord: r => r.type !== "session_continuation" }), /source-scope-changed/);
});

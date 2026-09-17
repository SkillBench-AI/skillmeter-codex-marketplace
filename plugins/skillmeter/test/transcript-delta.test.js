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
const scope = { deviceId: "SYNTHETIC", owner: "fixture-owner", cwd: "/synthetic", org: "synthetic" };
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

test("append cursor retains identical raw records, partial tails and redaction collisions", t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, line("repeat") + line("repeat") + '{"type":');
  const first = f.stage();
  assert.equal(first.cursor.offset, Buffer.byteLength(line("repeat")) * 2);
  const initial = f.records(first.files);
  assert.equal(initial.length, 2); assert.notEqual(initial[0].uuid, initial[1].uuid);
  assert.equal(f.stage().status, "unchanged");
  fs.appendFileSync(f.source, '"event_msg","payload":{"type":"token_count"}}\n');
  const next = f.stage();
  assert.equal(next.cursor.seq, 2); assert.equal(next.cursor.baseline, 1);
  assert.equal(f.records(next.files).length, 1);
  fs.appendFileSync(f.source, line("alice@example.com") + line("bob@example.com"));
  const redacted = f.records(f.stage().files);
  assert.deepEqual(redacted[0].payload, redacted[1].payload);
  assert.notEqual(redacted[0].uuid, redacted[1].uuid);
});

test("rewrites and replacement reset monotonically; later normal chunks carry the reset generation", t => {
  const f = fixture(t); fs.writeFileSync(f.source, line("old")); const one = f.stage();
  fs.writeFileSync(f.source, line("new")); const reset = f.stage();
  assert.equal(reset.cursor.baseline, 2); assert.equal(reset.cursor.generation, 2);
  fs.appendFileSync(f.source, line("continued")); const next = f.stage();
  assert.equal(queue.metadata(next.files[0]).reset, 2);
  assert.equal(next.cursor.seq, 3);
  fs.renameSync(f.source, f.source + ".old"); fs.writeFileSync(f.source, line("replacement"));
  assert.equal(f.stage().cursor.baseline, 4);
  assert.equal(f.records(one.files)[0].payload.content, "old", "staging never overwrites pending bodies");
});

for (const point of ["before-publish", "after-publish", "after-cursor"]) {
  test(`restart after crash at ${point} keeps exactly one logical chunk`, async t => {
    const f = fixture(t); fs.writeFileSync(f.source, line("crash recovery"));
    assert.throws(() => f.stage({ fault: at => { if (at === point) throw new Error("simulated crash"); } }));
    f.stage();
    const dirs = queue.queueDirectories(f.root), seen = [];
    await queue.drainDirectory(dirs[0], async (meta, body) => { seen.push({ meta, body }); return "sent"; });
    assert.equal(seen.length, 1); assert.equal(seen[0].meta.seq, 1);
    assert.equal(zlib.gunzipSync(seen[0].body).toString().trim().split("\n").length, 1);
  });
}

test("lost response retries byte-identical body, sequence and reset before later chunks", async t => {
  const f = fixture(t); fs.writeFileSync(f.source, line("one")); f.stage();
  fs.appendFileSync(f.source, line("two")); f.stage();
  const dir = queue.queueDirectories(f.root)[0], attempts = [];
  await queue.drainDirectory(dir, async (meta, body) => { attempts.push({ meta, body }); return "retry"; });
  assert.equal(attempts.length, 1); assert.equal(queue.pendingFiles(dir).length, 2);
  await queue.drainDirectory(dir, async (meta, body) => { attempts.push({ meta, body }); return "sent"; });
  assert.deepEqual(attempts[0], attempts[1]);
  assert.deepEqual(attempts.map(a => a.meta.seq), [1, 1, 2]);
  assert.equal(queue.pendingFiles(dir).length, 0);
  fs.appendFileSync(f.source, line("three")); assert.equal(f.stage().cursor.seq, 3);
});

test("one effective drain sequence prevents staging and a second sender while a request is open", async t => {
  const f = fixture(t); fs.writeFileSync(f.source, line("one")); const first = f.stage();
  let resolve; const response = new Promise(r => { resolve = r; });
  let opened; const requestOpened = new Promise(r => { opened = r; });
  const dir = queue.queueDirectories(f.root)[0];
  const drain = queue.drainDirectory(dir, async () => { opened(); await response; return "sent"; });
  await requestOpened;
  fs.appendFileSync(f.source, line("two")); assert.equal(f.stage().status, "busy");
  assert.equal(await queue.drainDirectory(dir, () => assert.fail("second sender")), 0);
  resolve(); await drain;
  assert.equal(f.stage().cursor.seq, 2); assert.equal(fs.existsSync(first.files[0]), false);
});

test("dead staging owner recovers on restart; an old live lock is never stolen", t => {
  const f = fixture(t), lock = path.join(f.dir, "lock");
  const child = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(require.resolve('../scripts/lib/transcript-delta'))}).acquireLock(process.argv[1]);`, lock]);
  assert.equal(child.status, 0);
  const release = queue.acquireLock(lock); assert.equal(typeof release, "function");
  fs.utimesSync(lock, new Date(0), new Date(0)); assert.equal(queue.acquireLock(lock), null); release();
});

test("actual gzip/base64 wire budget splits records and rejects an oversized single record without a cursor", t => {
  const f = fixture(t), limit = queue.ENVELOPE_RESERVE + 1200;
  const records = Array.from({ length: 8 }, () => line(crypto.randomBytes(500).toString("base64")));
  fs.writeFileSync(f.source, records.join(""));
  const result = f.stage({ maxEnvelope: limit }); assert.ok(result.files.length > 1);
  for (const file of result.files) assert.ok(4 * Math.ceil(fs.statSync(file).size / 3) + queue.ENVELOPE_RESERVE <= limit);
  assert.equal(f.records(result.files).length, 8);
  const before = result.cursor.seq;
  fs.appendFileSync(f.source, line(crypto.randomBytes(3000).toString("base64")));
  assert.throws(() => f.stage({ maxEnvelope: limit }), /oversized-single-record/);
  const dir = queue.queueDirectories(f.root)[0];
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "cursor.json"))).seq, before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "diagnostic.json"))).code, "oversized-single-record");
});

test("malformed complete lines retain cursor; unsupported envelope bytes remain available to the parser", t => {
  const f = fixture(t); fs.writeFileSync(f.source, line("one")); const first = f.stage();
  fs.appendFileSync(f.source, "malformed synthetic line\n");
  assert.throws(() => f.stage(), /malformed-complete-record/);
  const dir = queue.queueDirectories(f.root)[0];
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "cursor.json"))).offset, first.cursor.offset);
  fs.writeFileSync(f.source, line("one") + '{"type":"future-envelope"}\n');
  assert.equal(f.records(f.stage().files)[0].type, "future-envelope");
});

test("bounded capture resumes from the last complete raw position", t => {
  const f = fixture(t); fs.writeFileSync(f.source, Array.from({length: 10000}, (_, i) => line(String(i))).join(""));
  const all = [];
  for (let i = 0; i < 100; i++) { const result = f.stage({ stageBytes: 1000 }); if (!result.files.length) break; all.push(...f.records(result.files)); }
  assert.equal(all.length, 10000); assert.equal(new Set(all.map(r => r.uuid)).size, 10000);
});

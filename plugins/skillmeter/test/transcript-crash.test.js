"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const queue = require("../scripts/lib/transcript-delta");
const modulePath = require.resolve("../scripts/lib/transcript-delta");
const scope = { deviceId: "SYNTHETIC", owner: "synthetic-owner" };
const raw = '{"type":"response_item","payload":{"type":"message","role":"user","content":"survive termination"}}\n';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-kill-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source.jsonl");
  fs.writeFileSync(source, raw);
  return { root: path.join(root, "queue"), source };
}

for (const point of ["before-publish", "after-publish", "after-cursor"]) {
  test(`SIGKILL at ${point} recovers durable data without finally cleanup`, async (t) => {
    const f = fixture(t);
    const child = spawnSync(process.execPath, ["-e", `
      const queue = require(process.argv[1]);
      queue.stage(process.argv[2], process.argv[3], JSON.parse(process.argv[4]), "salt", {
        fault(point) { if (point === process.argv[5]) process.kill(process.pid, "SIGKILL"); }
      });
    `, modulePath, f.root, f.source, JSON.stringify(scope), point]);
    assert.equal(child.signal, "SIGKILL", child.stderr.toString());
    const dir = queue.queueDirectories(f.root)[0];
    assert.ok(fs.existsSync(path.join(dir, "lock")), "killed process must leave its lock");
    queue.stage(f.root, f.source, scope, "salt");
    const sent = [];
    await queue.drainDirectory(dir, async (meta, body) => {
      sent.push({ meta, records: zlib.gunzipSync(body).toString().trim().split("\n").map(JSON.parse) });
      return "sent";
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].meta.seq, 1);
    assert.equal(sent[0].records.length, 1);
    assert.deepEqual(sent[0].records[0].payload, JSON.parse(raw).payload);
    assert.equal(queue.pendingFiles(dir).length, 0);
  });
}

test("SIGKILL after remote acceptance replays identical bytes and metadata", async (t) => {
  const f = fixture(t);
  queue.stage(f.root, f.source, scope, "salt");
  const dir = queue.queueDirectories(f.root)[0];
  const accepted = path.join(path.dirname(f.source), "accepted.json");
  const child = spawnSync(process.execPath, ["-e", `
    const fs = require("node:fs"), queue = require(process.argv[1]);
    queue.drainDirectory(process.argv[2], async (meta, body) => {
      fs.writeFileSync(process.argv[3], JSON.stringify({meta, body: body.toString("base64")}));
      process.kill(process.pid, "SIGKILL");
    });
  `, modulePath, dir, accepted]);
  assert.equal(child.signal, "SIGKILL", child.stderr.toString());
  const previous = JSON.parse(fs.readFileSync(accepted));
  let attempts = 0;
  await queue.drainDirectory(dir, async (meta, body) => {
    attempts++;
    assert.deepEqual({ meta, body: body.toString("base64") }, previous);
    return "sent";
  });
  assert.equal(attempts, 1);
  assert.equal(queue.pendingFiles(dir).length, 0);
});

test("lock released between exclusive-link failure and inspection is retried", (t) => {
  const f = fixture(t);
  const lock = path.join(path.dirname(f.source), "lock");
  const release = queue.acquireLock(lock);
  const link = fs.linkSync;
  let raced = false;
  fs.linkSync = function (source, destination) {
    if (destination === lock && !raced) {
      raced = true;
      // The other process releases immediately after our link sees EEXIST.
      release();
      const error = new Error("synthetic concurrent release");
      error.code = "EEXIST";
      throw error;
    }
    return link.call(this, source, destination);
  };
  try {
    const acquired = queue.acquireLock(lock);
    assert.equal(typeof acquired, "function");
    acquired();
  } finally {
    fs.linkSync = link;
  }
});

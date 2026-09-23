"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { stage } = require("../scripts/lib/transcript-delta");
const { hashHmac } = require("../scripts/sanitizer");
const fixture = require("./fixtures/native-completion.cjs");
const salt = "synthetic-native-compat-salt";

function stageRecords(t, records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-sanitizer-compat-"));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const source = path.join(dir, "synthetic.jsonl");
  fs.writeFileSync(source, records.map(JSON.stringify).join("\n") + "\n");
  const root = path.join(dir, "queue");
  const scope = {owner: "fixture-owner", deviceId: "SYNTHETIC", cwd: "/synthetic", org: "synthetic"};
  const first = stage(root, source, scope, salt);
  assert.equal(first.status, "staged");
  assert.equal(first.cursor.lineCount, records.length);
  assert.equal(stage(root, source, scope, salt).status, "unchanged");
  return first.files.flatMap(f => zlib.gunzipSync(fs.readFileSync(f)).toString().trim().split("\n").map(JSON.parse));
}

test("sanitizer/queue preserve native identity, statuses and multi-file evidence after redaction", t => {
  const home = os.homedir();
  const raw = fixture.records(home);
  const out = stageRecords(t, raw);
  assert.equal(out[0].payload.id, raw[0].payload.id);
  assert.equal(out[0].payload.cwd, hashHmac(raw[0].payload.cwd, salt));
  const before = raw.filter(r => r.payload.type === "item_completed").map(r => r.payload);
  const after = out.filter(r => r.payload.type === "item_completed").map(r => r.payload);
  assert.equal(after.length, 5);
  for (let i = 0; i < after.length; i++) {
    for (const field of ["thread_id", "turn_id", "started_at_ms", "completed_at_ms"])
      assert.equal(after[i][field], before[i][field]);
    for (const field of ["id", "type", "status", "exit_code"])
      assert.equal(after[i].item[field], before[i].item[field]);
  }
  const changes = Object.values(after[0].item.changes);
  assert.deepEqual(changes.map(c => c.type), ["update", "add", "delete", "update"]);
  assert.ok(changes[0].unified_diff.includes("+return units * price;"));
  assert.ok(changes[1].content.includes("module.exports = 1;"));
  assert.ok(changes[2].content.includes("old value"));
  assert.equal(changes[3].move_path, `${hashHmac(home, salt)}/synthetic-native-work/src/moved.cjs`);
  assert.ok(Object.keys(after[0].item.changes).every(p => p.startsWith(hashHmac(home, salt) + "/")));
  const text = JSON.stringify(out);
  assert.equal(text.includes(fixture.token), false);
  assert.equal(text.includes(fixture.email), false);
  assert.equal(text.includes(home), false);
  assert.ok(text.includes("[REDACTED_SECRET]") && text.includes("[EMAIL]"));
  for (const item of after.slice(2).map(p => p.item)) {
    assert.ok(Array.isArray(item.command));
    assert.equal(item.command[0], "node");
    assert.equal(item.cwd, out[0].payload.cwd);
  }
  assert.equal(out[2].payload.call_id, out.at(-1).payload.call_id);
  assert.equal(out[2].payload.input, hashHmac(raw[2].payload.input, salt));
  assert.ok(out.every(r => r._sanitization.policyVersion === "3.1.1"));
  assert.equal(new Set(out.map(r => r.uuid)).size, out.length);
});

test("distinct native file changes must survive path-key redaction collisions", t => {
  const record = {type: "event_msg", payload: {type: "item_completed", thread_id: "synthetic", turn_id: "turn", item: {
    type: "FileChange", id: "collision", status: "completed", changes: {
      "/synthetic/alice@example.com/cart.cjs": {type: "add", content: "first"},
      "/synthetic/bob@example.com/cart.cjs": {type: "add", content: "second"},
    },
  }}};
  const [out] = stageRecords(t, [record]);
  assert.equal(JSON.stringify(out).includes("@example.com"), false, "redaction must remain effective");
  assert.equal(Object.keys(out.payload.item.changes).length, 2, "both observed file changes must survive");
  assert.deepEqual(Object.values(out.payload.item.changes).map(change => change.content), ["first", "second"]);
  assert.ok(Object.keys(out.payload.item.changes).every(key => key.endsWith(".cjs")));
});

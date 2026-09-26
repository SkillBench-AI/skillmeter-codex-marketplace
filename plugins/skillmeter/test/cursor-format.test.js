"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const q = require("../scripts/lib/transcript-delta");

for (const location of ["cursor", "transaction"]) for (const field of ["version", "metadataVersion"]) {
  test(`unknown ${field} in ${location} holds before recovery or drain mutation`, async t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-format-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const source = path.join(temp, "source.jsonl"), root = path.join(temp, "queue");
    fs.writeFileSync(source, JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }) + "\n");
    const scope = { owner: "fixture", deviceId: "fixture", cwd: "/synthetic", repoRoot: "/synthetic", org: "synthetic" };
    const staged = q.stage(root, source, scope, "fixture");
    const dir = q.queueDirectories(root)[0];
    const target = location === "cursor" ? path.join(dir, "cursor.json") : path.join(path.dirname(staged.files[0]), "commit.json");
    const data = JSON.parse(fs.readFileSync(target));
    (location === "cursor" ? data : data.cursor)[field] = 99;
    fs.writeFileSync(target, JSON.stringify(data));
    if (location === "transaction") fs.unlinkSync(path.join(dir, "cursor.json"));
    const snapshot = () => fs.readdirSync(dir, { recursive: true }).filter(f => fs.statSync(path.join(dir, f)).isFile() && f !== "diagnostic.json")
      .sort().map(f => [f, fs.readFileSync(path.join(dir, f)).toString("base64")]);
    const before = snapshot();
    assert.throws(() => q.observeConsent(root, source, scope, "fixture", true, "fixture"), /unsupported-cursor-format/);
    assert.deepEqual(snapshot(), before);
    assert.throws(() => q.stage(root, source, scope, "fixture"), /unsupported-cursor-format/);
    assert.deepEqual(snapshot(), before);
    let sends = 0;
    await assert.rejects(() => q.drainDirectory(dir, async () => { sends++; return "sent"; }), /unsupported-cursor-format/);
    assert.equal(sends, 0);
    assert.deepEqual(snapshot(), before);
  });
}

"use strict";
// Controls/receipts only. The user prompt and Stop must come from the desktop.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), zlib = require("node:zlib");
const { begin, verify, settled } = require("./verify-turn.cjs");
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const rows = file => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const marker = "SHARED-OVERLAP";
function arm(base, label) {
  assert.ok(!fs.existsSync(path.join(base, "overlap.json")), "overlap-already-used");
  const state = begin(base, label, marker, "delivered", 0);
  const callbackCount = rows(path.join(base, "callbacks.jsonl")).length;
  fs.writeFileSync(path.join(base, "receiver.json"), '{"status":200}', { mode: 0o600 });
  fs.writeFileSync(path.join(base, "overlap.json"), JSON.stringify({ label, callbackCount, expiresAt: Date.now() + 15 * 60000 }), { mode: 0o600, flag: "wx" });
  return state;
}
function check(base) {
  settled(base);
  const held = read(path.join(base, "overlap-held.json")), released = read(path.join(base, "overlap-release.json"));
  assert.ok(held.pid === released.pid && released.newerTrigger && Date.parse(released.stopAt) >= held.at && released.at >= Date.parse(released.stopAt), "overlap-not-proven");
  const snapshot = read(path.join(base, "verification", marker + ".private.json"));
  const callbacks = rows(path.join(base, "callbacks.jsonl")).slice(snapshot.callbackCount);
  assert.equal(callbacks.filter(c => c.label === snapshot.label && c.hook === "stop.js" && c.outcome === "candidate-completed").length, 1, "unexpected-extra-stop");
  const receipts = fs.readdirSync(path.join(base, "received")).filter(f => f.endsWith(".json") && !snapshot.received.includes(f));
  const all = receipts.map(f => ({ meta: read(path.join(base, "received", f)), file: path.join(base, "received", f.replace(/\.json$/, ".gz")) }));
  const transcript = all.filter(r => r.meta.path === "/logs/codex/transcript");
  const delivered = transcript.flatMap(r => zlib.gunzipSync(fs.readFileSync(r.file)).toString().split("\n").filter(Boolean).map(JSON.parse));
  const content = delivered.filter(r => !["session_meta", "session_continuation"].includes(r.type));
  assert.ok(content.every(r => typeof r.uuid === "string"), "missing-transport-id");
  assert.equal(new Set(content.map(r => r.uuid)).size, content.length, "duplicate-delivered-record");
  assert.equal(new Set(transcript.map(r => r.meta.seq)).size, transcript.length, "duplicate-chunk-attempt");
  const receipt = verify(base, marker);
  const result = { ...receipt, overlap: "native Stop observed during owned upload", transcriptRequests: transcript.length };
  fs.writeFileSync(path.join(base, "verification/overlap-result.json"), JSON.stringify(result, null, 2), { mode: 0o600, flag: "wx" });
  return result;
}
if (require.main === module) {
  try {
    const [mode, directory, label = "a"] = process.argv.slice(2);
    assert.ok(directory, "missing-directory");
    const base = path.resolve(directory);
    console.log(JSON.stringify(mode === "arm" ? arm(base, label) : mode === "verify" ? check(base) : (() => { throw Error("unknown-command"); })(), null, 2));
  } catch (e) { console.error(JSON.stringify({ status: "blocked", code: e.code === "ERR_ASSERTION" ? e.message.split("\n")[0] : "inspection-failed" })); process.exitCode = 1; }
}
module.exports = { arm, check };

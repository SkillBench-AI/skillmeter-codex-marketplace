"use strict";
// Read-only inspection of the candidate; writes only private verifier receipts.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), zlib = require("node:zlib");
const assert = require("node:assert/strict"), { isDeepStrictEqual } = require("node:util");
const read = p => JSON.parse(fs.readFileSync(p, "utf8"));
const lines = p => fs.readFileSync(p, "utf8").split("\n").filter(x => x.trim()).map(JSON.parse);
const hash = x => crypto.createHash("sha256").update(x).digest("hex");
const names = p => fs.existsSync(p) ? fs.readdirSync(p).sort() : [];
const walk = p => !fs.existsSync(p) ? [] : fs.readdirSync(p, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(p, e.name)) : [path.join(p, e.name)]);
const unpack = p => zlib.gunzipSync(fs.readFileSync(p)).toString().split("\n").filter(x => x.trim()).map(JSON.parse);
const isUserMarker = (r, m) => r.type === "response_item" && r.payload?.type === "message" &&
  r.payload.role === "user" && JSON.stringify(r.payload.content).includes(m);
function settled(base) {
  assert.ok(!fs.existsSync(path.join(base, "data/logs/.drain-once.lock")), "drain-active");
}
function identity(base, label) {
  const cfg = read(path.join(base, "config.json"));
  assert.ok(Object.hasOwn(cfg.workspaces, label), "unknown-label");
  const binding = read(path.join(base, "bindings", label + ".json"));
  const source = lines(binding.source), meta = source[0];
  assert.ok(meta?.type === "session_meta" && meta.payload.id === binding.id &&
    meta.payload.cwd === cfg.workspaces[label], "binding-mismatch");
  assert.ok(meta.payload.source === "vscode" && meta.payload.originator === "Codex Desktop", "not-desktop-source");
  return { cfg, binding, source };
}
function payloads(base) {
  const root = path.join(base, "data/logs");
  return [...walk(path.join(root, "transcripts")).filter(p => p.endsWith(".gz")),
    ...names(root).filter(f => /^events\.jsonl(?:\.\d+)?$/.test(f)).map(f => path.join(root, f))];
}
function snapshotPayloads(base) {
  return Object.fromEntries(payloads(base).sort().map(p => [path.relative(base, p), hash(fs.readFileSync(p))]));
}
function save(base, name, value) {
  const dir = path.join(base, "verification"); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}
function begin(base, label, marker, mode, pairs = 0) {
  assert.match(marker, /^SHARED-[A-Z0-9-]+$/);
  assert.ok(["queued", "delivered", "excluded"].includes(mode), "invalid-mode");
  assert.ok(Number.isInteger(pairs) && pairs >= 0, "invalid-pair-count");
  settled(base);
  const { cfg, binding, source } = identity(base, label);
  assert.ok(!fs.existsSync(path.join(base, "disabled")) && Date.now() < cfg.expiresAt, "inactive-canary");
  assert.ok(!source.some(r => JSON.stringify(r).includes(marker)), "marker-already-used");
  const callbacks = path.join(base, "callbacks.jsonl");
  const state = { label, marker, mode, pairs, binding, heads: cfg.heads, sourceCount: source.length,
    callbackCount: fs.existsSync(callbacks) ? lines(callbacks).length : 0,
    payloads: snapshotPayloads(base), received: names(path.join(base, "received")),
    attempts: names(path.join(base, "attempts")), at: new Date().toISOString() };
  save(base, marker + ".private.json", state);
  return { label, marker, mode, state: "awaiting-native-prompt", expectedToolPairs: pairs };
}
function verify(base, marker) {
  assert.match(marker, /^SHARED-[A-Z0-9-]+$/); settled(base);
  const s = read(path.join(base, "verification", marker + ".private.json"));
  const { cfg, binding, source } = identity(base, s.label);
  assert.ok(isDeepStrictEqual(binding, s.binding) && isDeepStrictEqual(cfg.heads, s.heads), "candidate-changed");
  const fresh = source.slice(s.sourceCount);
  assert.equal(fresh.filter(r => isUserMarker(r, marker)).length, 1, "missing-or-duplicate-user-prompt");
  const start = fresh.findIndex(r => isUserMarker(r, marker));
  const end = fresh.findIndex((r, i) => i >= start && r.type === "event_msg" && r.payload?.type === "task_complete");
  assert.ok(end >= start, "turn-not-complete");
  const turn = fresh.slice(start, end + 1);
  assert.equal(turn.filter(r => r.type === "event_msg" && r.payload?.type === "task_complete").length, 1, "turn-not-complete");
  const cb = lines(path.join(base, "callbacks.jsonl")).slice(s.callbackCount)
    .filter(x => x.label === s.label && x.outcome === "candidate-completed");
  assert.ok(["user_prompt_submit.js", "stop.js"].every(h => cb.some(x => x.hook === h)), "native-submit-stop-missing");
  const calls = turn.filter(r => r.type === "response_item" && ["function_call", "custom_tool_call"].includes(r.payload?.type));
  const outputs = turn.filter(r => r.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(r.payload?.type));
  assert.equal(calls.length, s.pairs, "tool-call-count"); assert.equal(outputs.length, s.pairs, "tool-result-count");
  assert.equal(new Set(calls.map(r => r.payload.call_id)).size, s.pairs, "duplicate-tool-id");
  assert.ok(calls.every(r => typeof r.payload.call_id === "string" && outputs.filter(o => o.payload.call_id === r.payload.call_id).length === 1), "unlinked-tool-result");
  if (s.mode === "excluded") {
    assert.ok(isDeepStrictEqual(snapshotPayloads(base), s.payloads), "queued-payloads-changed");
    assert.ok(isDeepStrictEqual(names(path.join(base, "received")), s.received), "unexpected-delivery");
    assert.ok(isDeepStrictEqual(names(path.join(base, "attempts")), s.attempts), "unexpected-upload-attempt");
  } else {
    const salt = read(path.join(base, "home/.skillbench/credentials.json")).hash_salt;
    let records;
    if (s.mode === "queued") {
      const key = crypto.createHmac("sha256", salt).update(path.resolve(binding.source)).digest("hex");
      records = walk(path.join(base, "data/logs/transcripts/chunks-v1", key)).filter(p => p.endsWith(".gz"))
        .sort((a, b) => Number(path.basename(a, ".gz")) - Number(path.basename(b, ".gz"))).flatMap(unpack);
      assert.ok(isDeepStrictEqual(names(path.join(base, "received")), s.received), "unexpected-delivery");
    } else {
      const receipts = names(path.join(base, "received")).filter(f => f.endsWith(".json") && !s.received.includes(f))
        .map(f => ({ file: path.join(base, "received", f.replace(/\.json$/, ".gz")), meta: read(path.join(base, "received", f)) }));
      assert.ok(receipts.length && receipts.every(x => x.meta.status === 200), "missing-successful-receipt");
      records = receipts.filter(x => x.meta.path === "/logs/codex/transcript")
        .sort((a, b) => Number(a.meta.seq) - Number(b.meta.seq)).flatMap(x => unpack(x.file));
      const hasPrivate = x => x && typeof x === "object" && (Object.hasOwn(x, "_queue") || Object.values(x).some(hasPrivate));
      assert.ok(!hasPrivate(receipts.flatMap(x => unpack(x.file))), "private-routing-on-wire");
    }
    const index = records.findIndex(r => isUserMarker(r, marker)); assert.ok(index >= 0, "captured-marker-missing");
    // Use a fresh isolated child so the pinned sanitizer resolves its expected HOME.
    const cp = require("node:child_process");
    const child = cp.spawnSync(process.execPath, ["-e", 'const fs=require("node:fs");const x=JSON.parse(fs.readFileSync(0,"utf8"));const s=require(process.argv[1]);process.stdout.write(JSON.stringify(x.rows.map(r=>s.sanitizeLine(r,x.salt))));', path.join(base, "codex/scripts/sanitizer.js")],
      { input: JSON.stringify({ rows: turn, salt }), encoding: "utf8", timeout: 10000, maxBuffer: 16 * 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: path.join(base, "home") } });
    assert.equal(child.status, 0, "sanitizer-failed");
    const normalized = records.slice(index, index + turn.length).map(r => { const v = { ...r }; delete v.uuid; return v; });
    assert.ok(isDeepStrictEqual(normalized, JSON.parse(child.stdout)), "sanitized-turn-mismatch");
  }
  const receipt = { label: s.label, marker, mode: s.mode, status: "passed", heads: s.heads,
    turnRecords: turn.length, linkedToolPairs: s.pairs, at: new Date().toISOString(),
    scope: "selected desktop turn only; intercepted delivery is not production acceptance" };
  save(base, marker + ".result.json", receipt); return receipt;
}
if (require.main === module) {
  try {
    const [command, directory, ...args] = process.argv.slice(2); assert.ok(directory, "missing-directory");
    const base = path.resolve(directory);
    const result = command === "begin" ? begin(base, args[0], args[1], args[2], Number(args[3] || 0)) :
      command === "verify" ? verify(base, args[0]) : (() => { throw Error("unknown-command"); })();
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    // Do not include assertion operands, transcript excerpts, paths or credentials.
    const code = e.code === "ERR_ASSERTION" ? e.message.split("\n")[0] : "inspection-failed";
    console.error(JSON.stringify({ status: "blocked", code })); process.exitCode = 1;
  }
}
module.exports = { begin, verify };

"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), zlib = require("node:zlib");
const { begin, verify } = require("./verify-turn.cjs");
const sanitizer = require("../../plugins/skillmeter/scripts/sanitizer.js");
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "native-verifier-")); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const dir of ["a", "bindings", "received", "attempts", "data/logs", "home/.skillbench", "codex/scripts/lib"]) fs.mkdirSync(path.join(base, dir), { recursive: true });
  const write = (name, data) => fs.writeFileSync(path.join(base, name), JSON.stringify(data));
  const source = path.join(base, "source.jsonl");
  write("config.json", { workspaces: { a: path.join(base, "a") }, heads: { codex: "synthetic", claude: "synthetic" }, expiresAt: Date.now() + 60000 });
  write("bindings/a.json", { id: "synthetic-session", source }); write("home/.skillbench/credentials.json", { hash_salt: "synthetic-salt" });
  fs.writeFileSync(source, JSON.stringify({ type: "session_meta", payload: { id: "synthetic-session", cwd: path.join(base, "a"), source: "vscode", originator: "Codex Desktop" } }) + "\n");
  fs.writeFileSync(path.join(base, "callbacks.jsonl"), "");
  for (const file of ["sanitizer.js", "lib/sanitize.js", "lib/rules.js", "lib/path-vocabulary.json"]) fs.copyFileSync(path.join(__dirname, "../../plugins/skillmeter/scripts", file), path.join(base, "codex/scripts", file));
  function turn(role = "user", submit = true, tools = [], sourceIds = false) {
    const rows = [{ type: "response_item", payload: { type: role === "user" ? "message" : "function_call_output", role, content: "SHARED-TEST" } },
      ...tools, { type: "response_item", payload: { type: "message", role: "assistant", content: "DONE" } },
      { type: "event_msg", payload: { type: "task_complete" } }];
    if (sourceIds) rows.forEach((r, i) => { r.uuid = "source-" + i; });
    fs.appendFileSync(source, rows.map(r => JSON.stringify(r) + "\n").join(""));
    for (const hook of submit ? ["user_prompt_submit.js", "stop.js"] : ["stop.js"]) fs.appendFileSync(path.join(base, "callbacks.jsonl"), JSON.stringify({ label: "a", hook, outcome: "candidate-completed" }) + "\n");
    return rows.map((r, i) => ({ ...sanitizer.sanitizeLine(r, "synthetic-salt"), ...(r.uuid ? { _codex_source_uuid: r.uuid } : {}), uuid: "synthetic-" + i }));
  }
  function deliver(rows) { write("received/one.json", { path: "/logs/codex/transcript", seq: "1", status: 200 }); fs.writeFileSync(path.join(base, "received/one.gz"), zlib.gzipSync(rows.map(r => JSON.stringify(r) + "\n").join(""))); }
  function queue(rows) {
    const key = crypto.createHmac("sha256", "synthetic-salt").update(source).digest("hex"), dir = path.join(base, "data/logs/transcripts/chunks-v1", key, "batch"); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "1.gz"), zlib.gzipSync(rows.map(r => JSON.stringify(r) + "\n").join("")));
  }
  return { base, source, write, turn, deliver, queue };
}
test("queued and delivered checks compare source values, not just counts", t => {
  for (const mode of ["queued", "delivered"]) {
    const f = fixture(t); begin(f.base, "a", "SHARED-TEST", mode); const rows = f.turn(); f[mode === "queued" ? "queue" : "deliver"](rows);
    assert.equal(verify(f.base, "SHARED-TEST").status, "passed");
  }
  const f = fixture(t); begin(f.base, "a", "SHARED-TEST", "delivered"); const rows = f.turn(); rows[1].payload.content = "changed"; f.deliver(rows);
  assert.throws(() => verify(f.base, "SHARED-TEST"), /sanitized-turn-mismatch/);
});
test("task message injected as tool output and Stop alone cannot qualify as native prompt", t => {
  const f = fixture(t); begin(f.base, "a", "SHARED-TEST", "excluded"); f.turn("tool", false);
  assert.throws(() => verify(f.base, "SHARED-TEST"), /missing-or-duplicate-user-prompt/);
  const g = fixture(t); begin(g.base, "a", "SHARED-TEST", "excluded"); g.turn("user", false);
  assert.throws(() => verify(g.base, "SHARED-TEST"), /native-submit-stop-missing/);
});
test("excluded turn retains backlog exactly and allows no attempts", t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.base, "data/logs/events.jsonl"), "original"); begin(f.base, "a", "SHARED-TEST", "excluded"); f.turn();
  assert.equal(verify(f.base, "SHARED-TEST").status, "passed");
  const g = fixture(t); begin(g.base, "a", "SHARED-TEST", "excluded"); g.turn(); fs.writeFileSync(path.join(g.base, "attempts/new.json"), "{}");
  assert.throws(() => verify(g.base, "SHARED-TEST"), /unexpected-upload-attempt/);
  const h = fixture(t); begin(h.base, "a", "SHARED-TEST", "excluded"); h.turn(); fs.writeFileSync(path.join(h.base, "data/logs/events.jsonl"), "unexpected");
  assert.throws(() => verify(h.base, "SHARED-TEST"), /queued-payloads-changed/);
});
test("private routing on wire fails even when transcript matches", t => {
  const f = fixture(t); begin(f.base, "a", "SHARED-TEST", "delivered"); const rows = f.turn(); rows[0]._queue = { scope: "synthetic" }; f.deliver(rows);
  assert.throws(() => verify(f.base, "SHARED-TEST"), /private-routing-on-wire/);
});
test("binding changes, busy drain, duplicate snapshots and retirement block advancement", t => {
  const f = fixture(t); begin(f.base, "a", "SHARED-TEST", "excluded"); assert.throws(() => begin(f.base, "a", "SHARED-TEST", "excluded"), /EEXIST/);
  f.turn(); f.write("bindings/a.json", { id: "other", source: f.source }); assert.throws(() => verify(f.base, "SHARED-TEST"), /binding-mismatch/);
  const g = fixture(t); fs.writeFileSync(path.join(g.base, "data/logs/.drain-once.lock"), "busy"); assert.throws(() => begin(g.base, "a", "SHARED-TEST", "excluded"), /drain-active/);
  const h = fixture(t); fs.writeFileSync(path.join(h.base, "disabled"), "retired"); assert.throws(() => begin(h.base, "a", "SHARED-TEST", "excluded"), /inactive-canary/);
});

test("linked tool inputs and results are compared after sanitization", t => {
  const tools = [
    { type: "response_item", payload: { type: "function_call", call_id: "call-1", name: "read_file", arguments: '{"path":"source.csv"}' } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "60 minutes" } },
  ];
  const f = fixture(t); begin(f.base, "a", "SHARED-TEST", "queued", 1); f.queue(f.turn("user", true, tools));
  assert.equal(verify(f.base, "SHARED-TEST").linkedToolPairs, 1);
  const g = fixture(t); begin(g.base, "a", "SHARED-TEST", "queued", 1);
  g.queue(g.turn("user", true, [tools[0], { ...tools[1], payload: { ...tools[1].payload, call_id: "wrong" } }]));
  assert.throws(() => verify(g.base, "SHARED-TEST"), /unlinked-tool-result/);
});

for (const mode of ["queued", "delivered"]) test(`${mode} preserves source UUIDs while ignoring transport UUIDs`, t => {
  const f = fixture(t); begin(f.base, "a", "SHARED-TEST", mode);
  f[mode === "queued" ? "queue" : "deliver"](f.turn("user", true, [], true));
  assert.equal(verify(f.base, "SHARED-TEST").status, "passed");
  const g = fixture(t); begin(g.base, "a", "SHARED-TEST", mode);
  const rows = g.turn("user", true, [], true); rows[1]._codex_source_uuid = "wrong-source";
  g[mode === "queued" ? "queue" : "deliver"](rows);
  assert.throws(() => verify(g.base, "SHARED-TEST"), /sanitized-turn-mismatch/);
});
test("process-owned drain lock blocks native verification", t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.base, "data/logs/.drain-once.worker.lock"), "busy");
  assert.throws(() => begin(f.base, "a", "SHARED-TEST", "excluded"), /drain-active/);
});

test("requested worker must finish before native verification can advance", t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.base, "data/logs/.drain-once.request"), "new");
  fs.writeFileSync(path.join(f.base, "data/logs/.drain-once.completed"), "old");
  assert.throws(() => begin(f.base, "a", "SHARED-TEST", "excluded"), /drain-pending/);
});

test("transport continuation headers do not interrupt native turn comparison", t => {
  for (const wrong of [false, true]) {
    const f=fixture(t); begin(f.base,"a","SHARED-TEST","delivered"); const records=f.turn();
    records.splice(1,0,sanitizer.sanitizeLine({type:"session_continuation",payload:{id:"synthetic-session",cwd:wrong ? "wrong" : path.join(f.base,"a"),source:"vscode",originator:"Codex Desktop"}},"synthetic-salt"));
    f.deliver(records);
    if(wrong) assert.throws(()=>verify(f.base,"SHARED-TEST"),/continuation-identity-mismatch/);
    else assert.equal(verify(f.base,"SHARED-TEST").status,"passed");
  }
});

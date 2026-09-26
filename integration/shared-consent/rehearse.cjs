"use strict";
// Synthetic subprocess rehearsal using the actual pinned Claude store. This does
// not launch Codex or count as native dispatch/production collector evidence.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), cp = require("node:child_process");
const assert = require("node:assert/strict");
const { prepare } = require("./prepare.cjs");
async function rehearse(claudeRepo) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-consent-rehearsal-"));
  const base = path.join(root, "canary");
  const prepared = prepare(base, claudeRepo);
  function run(...args) {
    const r = cp.spawnSync(process.execPath, [path.join(base, "run.cjs"), ...args], { encoding: "utf8", timeout: 10000 });
    assert.equal(r.status, 0, r.stderr); return r;
  }
  async function hook(label, name) {
    const r = cp.spawnSync(process.execPath, [path.join(base, "run.cjs"), "hook", name + ".js"], {
      encoding: "utf8", timeout: 10000, input: JSON.stringify({ cwd: path.join(base, label), session_id: "synthetic-" + label,
        transcript_path: path.join(base, label + ".jsonl"), tool_name: "synthetic", tool_input: {}, last_assistant_message: "synthetic" }),
    });
    assert.equal(r.status, 0, r.stderr);
    await settled();
  }
  async function settled() {
    // Stop creates the worker lock before spawning the detached process.
    for (let attempt = 0; attempt < 200; attempt++) {
      if (!fs.existsSync(path.join(base, "data/logs/.drain-once.lock"))) return;
      await new Promise(r => setTimeout(r, 25));
    }
    assert.fail("Detached worker did not finish");
  }
  function eventRows() {
    const dir = path.join(base, "data/logs");
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^events\.jsonl/.test(f)).flatMap(f =>
      fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)) : [];
  }
  function eventSnapshot() {
    const dir = path.join(base, "data/logs");
    return Object.fromEntries(fs.readdirSync(dir).filter(f => /^events\.jsonl/.test(f)).sort()
      .map(f => [f, fs.readFileSync(path.join(dir, f)).toString("hex")]));
  }
  const policyFile = path.join(base, "home/.skillbench/telemetry-policy.json");
  let succeeded = false;
  try {
    run("arm"); run("shared", "org", "on"); run("shared", "repo", "a", "on"); run("shared", "repo", "b", "on");
    for (const label of ["a", "clone", "worktree", "b"]) {
      const source = path.join(base, label + ".jsonl");
      fs.writeFileSync(source, JSON.stringify({ type: "session_meta", payload: { id: "synthetic-" + label, cwd: path.join(base, label), source: "cli" } }) + "\n");
      run("bind", label, "synthetic-" + label, source);
      await hook(label, "pre_tool_use");
      assert.equal(eventRows().some(r => r.session_id === "synthetic-" + label), false, "shared ON must not replace local consent");
      run("local", label, "enable"); await hook(label, "pre_tool_use");
    }
    assert.equal(eventRows().length, 4);
    const before = eventSnapshot();
    run("shared", "global", "off"); await hook("b", "pre_tool_use");
    assert.deepEqual(eventSnapshot(), before);
    run("shared", "global", "on");
    const policy = fs.readFileSync(policyFile);
    fs.writeFileSync(policyFile, "{broken"); await hook("b", "pre_tool_use");
    assert.deepEqual(fs.readFileSync(policyFile), Buffer.from("{broken"));
    assert.deepEqual(eventSnapshot(), before);
    fs.writeFileSync(policyFile, policy);
    run("shared", "repo", "clone", "off");
    for (const label of ["a", "clone", "worktree"]) await hook(label, "pre_tool_use");
    assert.deepEqual(eventRows().map(r => r.session_id), ["synthetic-b"]);
    await hook("b", "pre_tool_use"); // Observe restored permission before appending permitted source bytes.
    const records = [
      { type: "response_item", payload: { type: "message", role: "user", content: "SHARED-B-PERMITTED" } },
      { type: "response_item", payload: { type: "function_call", call_id: "synthetic-call", name: "read_file", arguments: '{"path":"source.csv"}' } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "synthetic-call", output: "60 minutes" } },
    ];
    fs.appendFileSync(path.join(base, "b.jsonl"), records.map(r => JSON.stringify(r) + "\n").join(""));
    run("receiver", "200"); await hook("b", "stop");
    const received = fs.readdirSync(path.join(base, "received")).filter(f => f.endsWith(".gz"));
    assert.ok(received.length, "Stop must invoke the intercepted receiver");
    const rows = received.flatMap(f => require("node:zlib").gunzipSync(fs.readFileSync(path.join(base, "received", f))).toString().trim().split("\n").filter(Boolean).map(JSON.parse));
    assert.ok(rows.some(r => r.session_id === "synthetic-b"));
    assert.equal(rows.some(r => ["synthetic-a", "synthetic-clone", "synthetic-worktree"].includes(r.session_id)), false);
    assert.equal(rows.some(r => Object.hasOwn(r, "_queue")), false);
    assert.ok(rows.some(r => r.payload?.content === "SHARED-B-PERMITTED"));
    assert.deepEqual(rows.filter(r => r.payload?.call_id === "synthetic-call").map(r => r.payload.type).sort(), ["function_call", "function_call_output"]);
    succeeded = true;
    return { evidence: "synthetic-subprocess-only", heads: prepared.heads, checks: ["local opt-in retained", "canonical Claude controls",
      "global pause retention", "malformed policy hold", "clone/worktree shared revocation", "unaffected B delivery", "linked transcript tool pair", "private routing stripped"] };
  } finally {
    // A failed retirement must not replace the rehearsal's own error.
    try { run("retire"); await settled(); } catch (e) { console.error("Retire failed", e); succeeded = false; }
    if (succeeded) fs.rmSync(root, { recursive: true, force: true });
    else console.error(`Synthetic failure artifacts retained at ${root}`);
  }
}
if (require.main === module) {
  if (!process.argv[2]) { console.error("Usage: node rehearse.cjs CLAUDE_CHECKOUT"); process.exitCode = 1; }
  else rehearse(path.resolve(process.argv[2])).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e); process.exitCode = 1; });
}
module.exports = { rehearse };

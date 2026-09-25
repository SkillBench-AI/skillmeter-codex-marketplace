"use strict";
// Synthetic subprocess rehearsal using the actual pinned Claude store. This does
// not launch Codex or count as native dispatch/production collector evidence.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), cp = require("node:child_process");
const assert = require("node:assert/strict");
const { prepare } = require("./prepare.cjs");
const { settled: assertSettled } = require("./verify-turn.cjs");
async function rehearse(claudeRepo, mode = "legacy") {
  if (!["legacy", "acknowledged"].includes(mode)) throw Error("Unknown rehearsal mode");
  const acknowledged = mode === "acknowledged";
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
    // Include requested workers that have not acquired their lock yet.
    for (let attempt = 0; attempt < 200; attempt++) {
      try { assertSettled(base); return; } catch (error) { if (error.code !== "ERR_ASSERTION") throw error; }
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
  function apply(label, choice) {
    const preview = JSON.parse(run("consent", label, "preview").stdout);
    const repository = `github.com/acme/${label === "b" ? "other" : "widgets"}`;
    assert.equal(preview.repository, repository);
    assert.equal(preview.changesApplied, false);
    assert.ok(Number.isInteger(preview.sharedRevision));
    return run("consent", label, choice, "--repository", repository,
      "--revision", String(preview.sharedRevision), ...(choice === "on" ? ["--acknowledge-machine-scope"] : []));
  }
  function append(label, marker) {
    fs.appendFileSync(path.join(base, label + ".jsonl"), JSON.stringify({ type: "response_item",
      payload: { type: "message", role: "user", content: marker } }) + "\n");
  }
  let succeeded = false;
  try {
    run("arm"); run("shared", "org", "on"); run("shared", "repo", "a", "on"); run("shared", "repo", "b", "on");
    if (acknowledged) {
      // Synthetic organization authorization only: the supplied legacy Claude
      // store does not implement the version-2 acknowledgement flow.
      const policy = JSON.parse(fs.readFileSync(policyFile));
      policy.organizations.acme.consent_version = 2;
      policy.revision++;
      fs.writeFileSync(policyFile, JSON.stringify(policy));
      apply("a", "on"); apply("b", "on");
    }
    for (const label of ["a", "clone", "worktree", "b"]) {
      const source = path.join(base, label + ".jsonl");
      fs.writeFileSync(source, JSON.stringify({ type: "session_meta", payload: { id: "synthetic-" + label, cwd: path.join(base, label), source: "cli" } }) + "\n");
      run("bind", label, "synthetic-" + label, source);
      if (acknowledged) {
        const local = path.join(base, label, ".codex/settings.local.json");
        assert.equal(fs.existsSync(local), false);
        fs.writeFileSync(local, JSON.stringify({ skillmeter: { telemetry: false } }));
        await hook(label, "pre_tool_use");
        assert.equal(eventRows().some(r => r.session_id === "synthetic-" + label), false, "local OFF restricts a shared grant");
        fs.unlinkSync(local); // Synthetic restriction removed; no local ON is written.
        await hook(label, "pre_tool_use");
        assert.equal(eventRows().filter(r => r.session_id === "synthetic-" + label).length, 1,
          "acknowledged shared grant must capture in every checkout");
        assert.equal(fs.existsSync(local), false);
      } else {
        await hook(label, "pre_tool_use");
        assert.equal(eventRows().some(r => r.session_id === "synthetic-" + label), false, "legacy shared ON must not replace local consent");
        run("local", label, "enable"); await hook(label, "pre_tool_use");
      }
    }
    assert.equal(eventRows().length, 4);
    const before = eventSnapshot();
    run("shared", "global", "off"); append("b", "SHARED-PAUSED-EXCLUDED"); await hook("b", "pre_tool_use");
    assert.deepEqual(eventSnapshot(), before);
    run("shared", "global", "on");
    const policy = fs.readFileSync(policyFile);
    fs.writeFileSync(policyFile, "{broken"); append("b", "SHARED-INVALID-EXCLUDED"); await hook("b", "pre_tool_use");
    assert.deepEqual(fs.readFileSync(policyFile), Buffer.from("{broken"));
    assert.deepEqual(eventSnapshot(), before);
    fs.writeFileSync(policyFile, policy);
    // An actual Claude legacy writer revokes Codex's acknowledged choice too.
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
    const sanitized = cp.spawnSync(process.execPath, ["-e",
      'const fs=require("node:fs"),s=require(process.argv[1]);process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(0,"utf8")).map(r=>s.sanitizeLine(r,"synthetic-salt"))));',
      path.join(base, "codex/scripts/sanitizer.js")], { input: JSON.stringify(records), encoding: "utf8", timeout: 10000,
      env: { PATH: process.env.PATH, HOME: path.join(base, "home") } });
    assert.equal(sanitized.status, 0, "pinned sanitizer failed");
    const captured = rows.filter(r => r.type === "response_item").map(r => { const copy = { ...r }; delete copy.uuid; return copy; });
    assert.deepEqual(captured, JSON.parse(sanitized.stdout), "complete permitted records arrive once, in order, after sanitization");
    assert.equal(rows.some(r => ["SHARED-PAUSED-EXCLUDED", "SHARED-INVALID-EXCLUDED"].includes(r.payload?.content)), false);
    if (acknowledged) {
      // A stale confirmation cannot undo the other client's revocation.
      const staleRevision = JSON.parse(fs.readFileSync(policyFile)).revision;
      run("shared", "repo", "clone", "off");
      const denied = cp.spawnSync(process.execPath, [path.join(base, "run.cjs"), "consent", "a", "on",
        "--repository", "github.com/acme/widgets", "--revision", String(staleRevision), "--acknowledge-machine-scope"],
        { encoding: "utf8", timeout: 10000 });
      assert.notEqual(denied.status, 0, "stale grant must be rejected");
      assert.equal(JSON.parse(fs.readFileSync(policyFile)).repositories["github.com/acme/widgets"].enabled, false);
      apply("a", "on");
      await hook("a", "pre_tool_use");
      assert.ok(eventRows().some(r => r.session_id === "synthetic-a"), "fresh explicit grant resumes capture");
      assert.equal(fs.existsSync(path.join(base, "a/.codex/settings.local.json")), false);
    }
    assert.deepEqual(rows.filter(r => r.payload?.call_id === "synthetic-call").map(r => r.payload.type).sort(), ["function_call", "function_call_output"]);
    succeeded = true;
    return { evidence: "synthetic-subprocess-only", mode, heads: prepared.heads,
      organizationAuthorization: acknowledged ? "synthetic version-2 fixture; not Claude acknowledgement acceptance" : "legacy Claude writer",
      checks: [acknowledged ? "shared grants across checkouts without local ON; local OFF retained" : "legacy local opt-in retained",
      ...(acknowledged ? ["actual Codex explicit repository command", "stale grant rejection after Claude revoke", "fresh explicit re-enable"] : []),
      "canonical Claude restriction controls", "paused/invalid transcript intervals excluded",
      "global pause retention", "malformed policy hold", "clone/worktree shared revocation", "unaffected B delivery", "linked transcript tool pair", "private routing stripped"] };
  } finally {
    run("retire"); await settled();
    if (succeeded) fs.rmSync(root, { recursive: true, force: true });
    else console.error(`Synthetic failure artifacts retained at ${root}`);
  }
}
if (require.main === module) {
  if (!process.argv[2]) { console.error("Usage: node rehearse.cjs CLAUDE_CHECKOUT [legacy|acknowledged]"); process.exitCode = 1; }
  else rehearse(path.resolve(process.argv[2]), process.argv[3]).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e); process.exitCode = 1; });
}
module.exports = { rehearse };

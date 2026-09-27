"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), cp = require("node:child_process");
const { inspect, plan, runAcceptance } = require("./acceptance.cjs");
const options = { codexRoot: "/synthetic/codex", claudeRoot: "/synthetic/claude", codexHead: "a".repeat(40), claudeHead: "b".repeat(40), contract: "legacy" };
const read = root => ({ head: root === options.codexRoot ? options.codexHead : root === options.claudeRoot ? options.claudeHead : "c".repeat(40), dirty: false });
const success = () => ({ status: 0, stdout: "synthetic detail not for receipt", stderr: "" });

test("passing subprocesses establish only local evidence and preserve unresolved gates", () => {
  const invocations = [];
  const r = runAcceptance(options, { read, execute: (args, opts) => { invocations.push({ args, opts }); return success(); } });
  assert.equal(r.status, "local_pass");assert.equal(r.checks.length, 3);
  assert.equal(r.remaining.liveCollector, "unverified");assert.equal(r.remaining.nativeDispatch, "unverified");
  assert.equal(r.remaining.transcriptExpiryAndReset, "decision_required");
  assert.equal(JSON.stringify(r).includes("synthetic detail"), false);
  assert.notEqual(invocations[0].opts.env.HOME, process.env.HOME);
  assert.equal(invocations[0].opts.env.GIT_CONFIG_GLOBAL, os.devNull);
  assert.equal(invocations[0].opts.env.NODE_OPTIONS, undefined);
  assert.equal(invocations[0].opts.env.AWS_PROFILE, undefined);
});

for (const failure of [{ status: 1 }, { status: null, error: { code: "ETIMEDOUT" } }, { status: 0, signal: "SIGTERM" }]) {
  test(`a failed/interrupted check cannot yield acceptance: ${JSON.stringify(failure)}`, () => {
    let calls = 0;
    const r = runAcceptance(options, { read, execute: () => { calls++;return failure; } });
    assert.equal(r.status, "failed");assert.equal(calls, 1);assert.equal(r.checks[0].status, "fail");
  });
}

for (const problem of ["dirty", "wrong-pin", "short-pin", "unknown-contract"]) {
  test(`preflight rejects ${problem} without executing candidate code`, () => {
    const changed = { ...options, ...(problem === "short-pin" ? { codexHead: "abcdef" } : {}), ...(problem === "unknown-contract" ? { contract: "auto" } : {}) };
    const r = runAcceptance(changed, { read: root => ({ ...read(root), ...(problem === "dirty" ? { dirty: true } : {}), ...(problem === "wrong-pin" ? { head: "d".repeat(40) } : {}) }), execute: () => assert.fail("must not execute") });
    assert.equal(r.status, "blocked");assert.equal(r.checks.length, 0);
  });
}

test("a candidate changed during execution invalidates green subprocess results", () => {
  let changed = false;
  const r = runAcceptance(options, { read: root => ({ ...read(root), dirty: changed }), execute: () => { changed = true;return success(); } });
  assert.equal(r.status, "blocked");assert.equal(r.reason, "candidate_changed_during_run");
});

test("legacy and counter writers select explicit rehearsal contracts", () => {
  assert.equal(plan("/c", "/a", "legacy")[2].args.at(-1), "legacy");
  assert.equal(plan("/c", "/a", "counters")[2].args.at(-1), "acknowledged");
});

test("Git inspection detects untracked and tracked changes", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-git-"));t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const git = args => { const r=cp.spawnSync("git", ["-C",root,...args], {encoding:"utf8"});assert.equal(r.status,0,r.stderr); };
  git(["init","-q"]);fs.writeFileSync(path.join(root,"source"),"before");git(["add","source"]);
  git(["-c","user.name=Synthetic","-c","user.email=synthetic@example.invalid","commit","-qm","fixture"]);
  assert.equal(inspect(root).dirty,false);
  fs.writeFileSync(path.join(root,"untracked"),"new");assert.equal(inspect(root).dirty,true);fs.unlinkSync(path.join(root,"untracked"));
  fs.writeFileSync(path.join(root,"source"),"after");assert.equal(inspect(root).dirty,true);
});

test("CLI refuses an existing receipt without replacing its bytes", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-output-"));t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const out = path.join(root,"receipt.json");fs.writeFileSync(out,"keep");
  const repo=path.resolve(__dirname,"../..");
  const r=cp.spawnSync(process.execPath,[path.join(__dirname,"acceptance.cjs"),repo,repo,"legacy",options.codexHead,options.claudeHead,out],{encoding:"utf8"});
  assert.notEqual(r.status,0);assert.equal(fs.readFileSync(out,"utf8"),"keep");assert.match(r.stderr,/EEXIST/);
});

test("inherited Git redirection cannot hide a dirty candidate", t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-redirect-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const clean = path.join(parent, "clean"), dirty = path.join(parent, "dirty");
  for (const root of [clean, dirty]) {
    fs.mkdirSync(root);
    for (const args of [["init", "-q"], ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "--allow-empty", "-qm", path.basename(root)]]) {
      const result = cp.spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
  }
  fs.writeFileSync(path.join(dirty, "untracked"), "must be detected");
  const expected = inspect(dirty);
  const result = cp.spawnSync(process.execPath, ["-e",
    "console.log(JSON.stringify(require(process.argv[1]).inspect(process.argv[2])))",
    path.join(__dirname, "acceptance.cjs"), dirty], {
    encoding: "utf8", env: { ...process.env, GIT_DIR: path.join(clean, ".git"), GIT_WORK_TREE: clean,
      GIT_INDEX_FILE: path.join(clean, ".git", "index") },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.equal(expected.dirty, true);
});

test("inspection rejects nested directories but accepts linked worktree roots", t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-root-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, "repo"), linked = path.join(parent, "linked");fs.mkdirSync(root);
  for (const args of [["init", "-q"], ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], ["worktree", "add", "--detach", linked]]) {
    const result = cp.spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const nested = path.join(root, "nested");fs.mkdirSync(nested);
  assert.throws(() => inspect(nested), /candidate_unavailable/);
  assert.deepEqual(inspect(linked), inspect(root));
});

"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const cp = require("node:child_process"), crypto = require("node:crypto");
const runnerRoot = path.resolve(__dirname, "../..");

function inspect(root) {
  const git = args => {
    const r = cp.spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10000 });
    if (r.status !== 0) throw Error("candidate_unavailable");
    return r.stdout.trim();
  };
  return { head: git(["rev-parse", "HEAD"]), dirty: !!git(["status", "--porcelain", "--untracked-files=normal"]) };
}

function plan(codexRoot, claudeRoot, contract) {
  if (!["legacy", "counters"].includes(contract)) throw Error("invalid_writer_contract");
  return [
    { id: "queue-regressions", args: ["--test", "plugins/skillmeter/test/consent/revocation-counters.test.js", "plugins/skillmeter/test/consent/queue-revocation.test.js"] },
    { id: "actual-writer-off-on", args: [path.join(__dirname, "check-writer.cjs"), codexRoot, claudeRoot, contract] },
    { id: "shared-consent-rehearsal", args: ["integration/shared-consent/rehearse.cjs", claudeRoot, contract === "legacy" ? "legacy" : "acknowledged"] },
  ];
}

function runAcceptance(options, { read = inspect, execute } = {}) {
  const { codexRoot, claudeRoot, codexHead, claudeHead, contract } = options;
  const report = { schemaVersion: 1, evidence: "synthetic-subprocess-only", status: "blocked",
    writerContract: contract, candidates: {}, runtime: { node: process.version, platform: process.platform }, checks: [],
    remaining: { nativeDispatch: "unverified", claudeCaptureRuntime: "unverified", liveCollector: "unverified",
      weeklyReport: "unverified", ambiguousQueueMigration: "decision_required", transcriptExpiryAndReset: "decision_required" } };
  let home;
  try {
    const steps = plan(codexRoot, claudeRoot, contract);
    if (![codexHead, claudeHead].every(value => /^[a-f0-9]{40}$/.test(value || ""))) throw Error("full_commit_pins_required");
    const roots = { codex: codexRoot, claude: claudeRoot, runner: runnerRoot };
    for (const [name, root] of Object.entries(roots)) {
      const candidate = read(root);
      if (candidate.dirty) throw Error("dirty_candidate");
      report.candidates[name] = candidate.head;
    }
    if (report.candidates.codex !== codexHead || report.candidates.claude !== claudeHead) throw Error("candidate_pin_mismatch");
    home = fs.mkdtempSync(path.join(os.tmpdir(), "consent-acceptance-"));
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, "codex"),
      CLAUDE_PLUGIN_DATA: path.join(home, "claude-data"), PLUGIN_DATA: path.join(home, "codex-data"),
      SKILLMETER_STATE_DIR: path.join(home, "state"), SKILLMETER_DISABLE_KEYCHAIN: "1",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull };
    for (const step of steps) {
      const result = (execute || ((args, opts) => cp.spawnSync(process.execPath, args, opts)))(step.args,
        { cwd: codexRoot, env, encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
      const pass = result.status === 0 && !result.signal && !result.error;
      report.checks.push({ id: step.id, status: pass ? "pass" : "fail", exitCode: result.status ?? null,
        signal: result.signal ?? null, errorCode: result.error?.code ?? null,
        outputSha256: crypto.createHash("sha256").update(result.stdout || "").update(result.stderr || "").digest("hex") });
      if (!pass) { report.status = "failed"; break; }
    }
    for (const [name, root] of Object.entries(roots)) {
      const candidate = read(root);
      if (candidate.dirty || candidate.head !== report.candidates[name]) throw Error("candidate_changed_during_run");
    }
    if (report.checks.length === steps.length && report.checks.every(step => step.status === "pass")) report.status = "local_pass";
  } catch (error) {
    report.status = "blocked";
    // Never put raw child output, paths, session records or credentials in receipts.
    const allowed = ["candidate_unavailable", "invalid_writer_contract", "full_commit_pins_required", "dirty_candidate", "candidate_pin_mismatch", "candidate_changed_during_run"];
    report.reason = allowed.includes(error.message) ? error.message : "runner_error";
  } finally {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  }
  return report;
}

if (require.main === module) {
  try {
    const [codex, claude, contract, codexHead, claudeHead, out, ...extra] = process.argv.slice(2);
    if (!out || extra.length) throw Error("Usage: node acceptance.cjs CODEX_CHECKOUT CLAUDE_CHECKOUT legacy|counters CODEX_SHA CLAUDE_SHA NEW_RECEIPT.json");
    const output = path.resolve(out), codexRoot = fs.realpathSync(codex), claudeRoot = fs.realpathSync(claude);
    const parent = fs.realpathSync(path.dirname(output));
    for (const root of [codexRoot, claudeRoot, runnerRoot]) {
      const relative = path.relative(fs.realpathSync(root), parent);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw Error("Receipt must be outside candidate checkouts");
    }
    const fd = fs.openSync(output, "wx", 0o600);
    try {
      const report = runAcceptance({ codexRoot, claudeRoot, contract, codexHead, claudeHead });
      fs.writeFileSync(fd, JSON.stringify(report, null, 2) + "\n");
      console.log(report.status);
      process.exitCode = report.status === "local_pass" ? 0 : 1;
    } finally { fs.closeSync(fd); }
  } catch (error) { console.error(error.code || error.message); process.exitCode = 1; }
}
module.exports = { inspect, plan, runAcceptance };

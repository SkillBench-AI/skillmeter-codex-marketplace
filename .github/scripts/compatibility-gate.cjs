"use strict";
const fs = require("node:fs"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const { load, validate, digest, revision, keys, sameSet } = require("./compatibility-contract.cjs");
const INPUTS = {
  producer: ["plugins/skillmeter/.codex-plugin/plugin.json"],
  collector: ["go.mod", "go.sum"],
  pipeline: ["uv.lock", "packages/preprocessor/tests/fixtures/codex_m0/substantive.jsonl", "packages/preprocessor/tests/fixtures/codex_m0/expected.json"],
};
function save(file, value) {
  const temporary = file + "." + require("node:crypto").randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
const COMPONENTS = ["producer", "claude", "collector", "pipeline"];
function check(valid, reason) { if (!valid) throw Error(reason); }
function timestamp(value) {
  check(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|\+00:00)$/.test(value), "invalid-evidence-time");
  const time = Date.parse(value); check(Number.isFinite(time), "invalid-evidence-time"); return time;
}
function evaluate(contract, expected, mixed, backend, now = Date.now()) {
  validate(contract);
  check(keys(expected, ["version", "startedAt", "revisions"]) && expected.version === 1 && keys(expected.revisions, COMPONENTS) && Object.values(expected.revisions).every(revision), "invalid-expected-candidate");
  const start = timestamp(expected.startedAt);
  check(start <= now && now - start <= 60 * 60 * 1000, "expired-gate-invocation");
  for (const receipt of [mixed, backend]) {
    check(receipt && typeof receipt === "object" && !Array.isArray(receipt), "missing-receipt");
    const first = timestamp(receipt.startedAt), last = timestamp(receipt.finishedAt);
    check(start <= first && first <= last && last <= now, "stale-or-future-evidence");
  }
  check(mixed.version === 1 && mixed.kind === "mixed-client-authorization-gate" && mixed.contractSha256 === digest(contract), "mixed-contract-mismatch");
  check(keys(mixed.revisions, ["codex", "claude"]) && mixed.revisions.codex === expected.revisions.producer && mixed.revisions.claude === expected.revisions.claude, "mixed-revision-mismatch");
  check(Array.isArray(mixed.results) && sameSet(mixed.results.map(row => row?.scenario), contract.requiredCases.mixedAuth) && mixed.results.every(row => keys(row, ["scenario", "status"]) && row.status === "pass"), "incomplete-mixed-evidence");
  check(backend.version === 1 && backend.kind === "synthetic-contract-run" && backend.status === "pass", "backend-contract-failed");
  check(backend.candidate?.version === 1 && backend.candidate.kind === "synthetic-contract-candidate" && keys(backend.candidate.components, ["producer", "collector", "pipeline"]), "invalid-backend-candidate");
  check(backend.candidateSha256 === digest(backend.candidate), "backend-candidate-digest-mismatch");
  for (const name of ["producer", "collector", "pipeline"]) {
    const component = backend.candidate.components[name];
    check(keys(component, ["revision", "inputs"]) && keys(component.inputs, INPUTS[name]) && Object.values(component.inputs).every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)), "invalid-backend-input-pins");
    check(component.revision === expected.revisions[name], "backend-revision-mismatch");
  }
  check(keys(backend.stages, contract.backendStages) && Object.values(backend.stages).every(stage => keys(stage, ["status"]) && stage.status === "pass"), "incomplete-backend-evidence");
  const evidence = backend.evidence, integrity = evidence?.recordIntegrity;
  check(evidence?.syntheticOnly === true && evidence.backendDashboard === false && evidence.independentRecordOracle === true && evidence.independentCanonicalOracle === true && evidence.storageFrameValidated === true && evidence.legacyMigrationVerified === true && evidence.analyzerReport?.schemaValidated === true && integrity?.status === "pass" && Array.isArray(integrity.issues) && integrity.issues.length === 0 && Number.isSafeInteger(evidence.records) && evidence.records > 0 && evidence.records === integrity.expectedRecords && evidence.records === integrity.observedRecords, "invalid-backend-evidence");
  return { version: 1, kind: "compatibility-acceptance", status: "pass", contractSha256: digest(contract), revisions: expected.revisions, scope: "synthetic-candidate-only" };
}
module.exports = { evaluate, INPUTS };
if (require.main === module) {
  const [expectedFile, mixedFile, backendFile, out] = process.argv.slice(2);
  if (!out || process.argv.length !== 6) { console.error("Usage: node compatibility-gate.cjs expected.json mixed.json backend.json output.json"); process.exitCode = 2; }
  else {
    if ([expectedFile, mixedFile, backendFile].some(file => path.resolve(file) === path.resolve(out)) || path.resolve(out).startsWith(path.resolve(__dirname, "../..") + path.sep)) {
      console.error("Output must be outside the checkout and distinct from inputs."); process.exitCode = 2;
    } else {
    let result = { version: 1, kind: "compatibility-acceptance", status: "failed", reason: "unreadable-input" };
    try {
      check(![expectedFile, mixedFile, backendFile].some(file => path.resolve(file) === path.resolve(out)), "output-overlaps-input");
      const root = path.resolve(__dirname, "../..");
      check(!path.resolve(out).startsWith(root + path.sep), "output-inside-checkout");
      // Replace an old success before attempting to read any evidence.
      save(out, result);
      const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
      const expected = read(expectedFile);
      const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      check(git(["status", "--porcelain", "--untracked-files=all"]) === "", "dirty-producer-checkout");
      check(git(["rev-parse", "HEAD"]) === expected.revisions?.producer, "producer-revision-mismatch");
      result = evaluate(load(), expected, read(mixedFile), read(backendFile));
    } catch (error) {
      // Emit only fixed reason codes, never JSON contents, paths or subprocess output.
      if (/^[a-z]+(?:-[a-z]+)+$/.test(error.message)) result.reason = error.message;
    }
    try { save(out, result); }
    catch { result = { status: "failed", reason: "unwritable-output" }; }
    console.log(JSON.stringify(result));
    process.exitCode = result.status === "pass" ? 0 : 1;
    }
  }
}

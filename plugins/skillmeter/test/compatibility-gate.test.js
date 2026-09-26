"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const { load, digest } = require("../../../.github/scripts/compatibility-contract.cjs");
const { evaluate, INPUTS } = require("../../../.github/scripts/compatibility-gate.cjs");
const now = Date.parse("2026-09-26T10:00:00Z");
function fixture() {
  const contract = load();
  const revisions = { producer: "1".repeat(40), claude: "2".repeat(40), collector: "3".repeat(40), pipeline: "4".repeat(40) };
  const expected = { version: 1, startedAt: "2026-09-26T09:50:00Z", revisions };
  const times = { startedAt: "2026-09-26T09:51:00Z", finishedAt: "2026-09-26T09:59:00Z" };
  const mixed = { version: 1, kind: "mixed-client-authorization-gate", contractSha256: digest(contract), ...times,
    revisions: { codex: revisions.producer, claude: revisions.claude },
    results: contract.requiredCases.mixedAuth.map(scenario => ({ scenario, status: "pass" })) };
  const candidate = { version: 1, kind: "synthetic-contract-candidate", components: Object.fromEntries(["producer", "collector", "pipeline"].map(name => [name, { revision: revisions[name], inputs: Object.fromEntries(INPUTS[name].map(file => [file, "a".repeat(64)])) }])) };
  const backend = { version: 1, kind: "synthetic-contract-run", status: "pass", ...times, candidate, candidateSha256: digest(candidate),
    stages: Object.fromEntries(contract.backendStages.map(name => [name, { status: "pass" }])),
    evidence: { syntheticOnly: true, backendDashboard: false, independentRecordOracle: true, independentCanonicalOracle: true, storageFrameValidated: true, legacyMigrationVerified: true,
      analyzerReport: { schemaValidated: true }, records: 2, recordIntegrity: { status: "pass", issues: [], expectedRecords: 2, observedRecords: 2 } } };
  const faults = {version:1,kind:"runtime-fault-gate",status:"pass",...times,contractSha256:digest(contract),revisions:{producer:revisions.producer,pipeline:revisions.pipeline},
    results:contract.requiredCases.runtimeFaults.map(scenario=>({scenario,status:"pass",baseline:"pass",mutant:"detected",reason:scenario,mutation:{beforeSha256:"a".repeat(64),afterSha256:"b".repeat(64)}}))};
  return { contract, expected, mixed, backend, faults };
}
function gate(f) { return evaluate(f.contract, f.expected, f.mixed, f.backend, f.faults, now); }
test("gate admits complete matching evidence without granting production acceptance", () => {
  const f = fixture(), result = gate(f);
  assert.equal(result.status, "pass");
  assert.equal(result.scope, "synthetic-candidate-only");
  assert.deepEqual(result.revisions, f.expected.revisions);
});
const failures = {
  "absent fault receipt": [f => { f.faults = null; }, /missing-receipt/],
  "failed fault suite": [f => { f.faults.status = "failed"; }, /runtime-fault-contract-failed/],
  "wrong fault contract": [f => { f.faults.contractSha256 = "0".repeat(64); }, /runtime-fault-contract-failed/],
  "wrong fault revision": [f => { f.faults.revisions.pipeline = "0".repeat(40); }, /runtime-fault-revision-mismatch/],
  "missing mutation": [f => { f.faults.results.pop(); }, /incomplete-runtime-fault-evidence/],
  "duplicate mutation": [f => { f.faults.results[1] = f.faults.results[0]; }, /incomplete-runtime-fault-evidence/],
  "broken pristine runtime": [f => { f.faults.results[0].baseline = "failed"; }, /incomplete-runtime-fault-evidence/],
  "surviving mutation": [f => { f.faults.results[0].mutant = "survived"; }, /incomplete-runtime-fault-evidence/],
  "unrelated mutant crash": [f => { f.faults.results[0].reason = "probe-error"; }, /incomplete-runtime-fault-evidence/],
  "unchanged mutation": [f => { f.faults.results[0].mutation.afterSha256 = f.faults.results[0].mutation.beforeSha256; }, /incomplete-runtime-fault-evidence/],
  "stale mutation": [f => { f.faults.startedAt = "2026-09-25T09:51:00Z"; }, /stale-or-future-evidence/],
  "wrong expected revision": [f => { f.expected.revisions.producer = "a".repeat(40); }, /mixed-revision-mismatch/],
  "floating expected pin": [f => { f.expected.revisions.claude = "main"; }, /invalid-expected-candidate/],
  "another contract": [f => { f.mixed.contractSha256 = "0".repeat(64); }, /mixed-contract-mismatch/],
  "absent mixed receipt": [f => { f.mixed = null; }, /missing-receipt/],
  "empty mixed successes": [f => { f.mixed.results = []; }, /incomplete-mixed-evidence/],
  "missing consent case": [f => { f.mixed.results.pop(); }, /incomplete-mixed-evidence/],
  "duplicate consent case": [f => { f.mixed.results[1] = f.mixed.results[0]; }, /incomplete-mixed-evidence/],
  "failed consent case": [f => { f.mixed.results[0].status = "fail"; }, /incomplete-mixed-evidence/],
  "skipped consent case": [f => { f.mixed.results[0].status = "skip"; }, /incomplete-mixed-evidence/],
  "ignored failure marker": [f => { f.mixed.results[0].ignoredFailure = true; }, /incomplete-mixed-evidence/],
  "missing collector stage": [f => { delete f.backend.stages["stored-records"]; }, /incomplete-backend-evidence/],
  "skipped collector stage": [f => { f.backend.stages["stored-records"].status = "not-run"; }, /incomplete-backend-evidence/],
  "incomplete backend despite pass": [f => { delete f.backend.evidence; }, /invalid-backend-evidence/],
  "truthy schema flag": [f => { f.backend.evidence.analyzerReport.schemaValidated = "true"; }, /invalid-backend-evidence/],
  "record loss": [f => { f.backend.evidence.recordIntegrity.observedRecords = 1; }, /invalid-backend-evidence/],
  "changed backend candidate": [f => { f.backend.candidate.components.collector.revision = "a".repeat(40); }, /backend-candidate-digest-mismatch/],
  "missing input pins": [f => { f.backend.candidate.components.collector.inputs = {}; f.backend.candidateSha256 = digest(f.backend.candidate); }, /invalid-backend-input-pins/],
  "different valid backend pin": [f => { f.backend.candidate.components.collector.revision = "a".repeat(40); f.backend.candidateSha256 = digest(f.backend.candidate); }, /backend-revision-mismatch/],
  "old successful evidence": [f => { f.mixed.startedAt = "2026-09-25T09:51:00Z"; }, /stale-or-future-evidence/],
  "future evidence": [f => { f.backend.finishedAt = "2026-09-27T09:59:00Z"; }, /stale-or-future-evidence/],
  "reversed times": [f => { f.backend.finishedAt = "2026-09-26T09:50:00Z"; }, /stale-or-future-evidence/],
  "missing times": [f => { delete f.backend.startedAt; }, /invalid-evidence-time/],
  "expired invocation": [f => { f.expected.startedAt = "2026-09-25T09:50:00Z"; }, /expired-gate-invocation/],
};
for (const [name, [mutate, reason]] of Object.entries(failures)) test(`gate rejects ${name}`, () => {
  const f = fixture(); mutate(f); assert.throws(() => gate(f), reason);
});
test("unreadable input replaces stale CLI success without exposing raw data", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compatibility-gate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "bad.json"), out = path.join(root, "result.json");
  fs.writeFileSync(input, "synthetic-private-content");
  fs.writeFileSync(out, '{"status":"pass"}');
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../../../.github/scripts/compatibility-gate.cjs"), input, input, input, input, out], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(fs.readFileSync(out)).status, "failed");
  assert.ok(!result.stdout.includes("synthetic-private-content"));
  assert.ok(!result.stderr.includes("synthetic-private-content"));
});

test("CLI refuses to replace an input with its own failure receipt", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compatibility-gate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "input.json"), bytes = '{"keep":"original"}';
  fs.writeFileSync(input, bytes);
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../../../.github/scripts/compatibility-gate.cjs"), input, input, input, input, input], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.equal(fs.readFileSync(input, "utf8"), bytes);
});

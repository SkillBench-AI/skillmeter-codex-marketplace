"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const DEFAULT_CONTRACT = path.resolve(__dirname, "../../compatibility/contract.json");
const REQUIRED = {
  releasedQueue: ["acknowledged", "pending"],
  releasedAuth: ["signed-in", "signed-out", "expired", "global-pause", "scope-withdrawn", "repository-off", "interrupted-refresh", "signout-signin-refresh", "auth-rejection"],
  mixedAuth: ["signed-in", "signed-out", "expired", "global-pause", "repository-off", "interrupted-refresh", "signout-signin-refresh", "auth-rejection"],
};
const BACKEND_STAGES = ["candidate", "build", "transport-recovery", "stored-records", "normalization", "scripted-analysis", "ingest-schema", "evidence", "candidate-recheck"];
const revision = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sameSet = (values, expected) => Array.isArray(values) && values.length === expected.length && new Set(values).size === values.length && values.every(v => expected.includes(v));
function requireValue(valid, reason) { if (!valid) throw Error(reason); }
function keys(value, expected) { return object(value) && sameSet(Object.keys(value), expected); }
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (object(value)) return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
const digest = value => crypto.createHash("sha256").update(canonical(value)).digest("hex");
function validate(contract) {
  requireValue(keys(contract, ["schemaVersion", "status", "producer", "distribution", "unknownUpgrade", "downgrade", "upgradePaths", "requiredCases", "backendStages"]), "invalid-contract-shape");
  requireValue(contract.schemaVersion === 1 && contract.status === "candidate" && contract.producer === "codex", "unsupported-contract");
  requireValue(sameSet(contract.distribution, ["main", "tag"]) && contract.unknownUpgrade === "block" && contract.downgrade === "blocked-unless-tested", "unsafe-distribution-policy");
  requireValue(keys(contract.requiredCases, Object.keys(REQUIRED)), "invalid-case-matrix");
  for (const [suite, required] of Object.entries(REQUIRED)) requireValue(sameSet(contract.requiredCases[suite], required), "incomplete-case-matrix");
  requireValue(sameSet(contract.backendStages, BACKEND_STAGES), "incomplete-backend-matrix");
  requireValue(Array.isArray(contract.upgradePaths) && contract.upgradePaths.length > 0, "empty-upgrade-matrix");
  const versions = new Set(), revisions = new Set();
  for (const row of contract.upgradePaths) {
    requireValue(keys(row, ["version", "revision", "consentJournal", "recovery"]), "invalid-upgrade-path");
    requireValue(typeof row.version === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(row.version) && revision(row.revision), "invalid-release-pin");
    requireValue(!versions.has(row.version) && !revisions.has(row.revision), "duplicate-upgrade-path");
    requireValue(typeof row.consentJournal === "boolean" && row.recovery === (row.consentJournal ? "existing-journal" : "explicit-range-migration"), "missing-recovery-path");
    versions.add(row.version); revisions.add(row.revision);
  }
  return contract;
}
function load(file = DEFAULT_CONTRACT) { return validate(JSON.parse(fs.readFileSync(file, "utf8"))); }
function upgradePath(contract, version) {
  validate(contract);
  const row = contract.upgradePaths.find(row => row.version === version);
  requireValue(Boolean(row), "unsupported-upgrade-path");
  return row;
}
module.exports = { load, validate, upgradePath, digest, revision, keys, sameSet };
if (require.main === module) {
  try {
    const contract = load();
    console.log(JSON.stringify({ status: "pass", contractSha256: digest(contract), upgradePaths: contract.upgradePaths.length }));
  } catch { console.error("Compatibility contract is invalid."); process.exitCode = 1; }
}

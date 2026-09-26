"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { load, validate, upgradePath } = require("../../../.github/scripts/compatibility-contract.cjs");

test("matrix selects explicit legacy migration and journal-preserving paths", () => {
  const contract = load();
  assert.equal(upgradePath(contract, "0.6.1").recovery, "explicit-range-migration");
  assert.equal(upgradePath(contract, "0.8.0").recovery, "existing-journal");
  assert.throws(() => upgradePath(contract, "99.0.0"), /unsupported-upgrade-path/);
});

const mutations = {
  "unknown schema": c => { c.schemaVersion = 2; },
  "implicit support promotion": c => { c.status = "supported"; },
  "missing main distribution gate": c => { c.distribution = ["tag"]; },
  "unknown versions allowed": c => { c.unknownUpgrade = "allow"; },
  "untested downgrade": c => { c.downgrade = "allow"; },
  "empty release matrix": c => { c.upgradePaths = []; },
  "duplicate release": c => { c.upgradePaths.push(c.upgradePaths[0]); },
  "floating release pin": c => { c.upgradePaths[0].revision = "main"; },
  "legacy path without migration": c => { c.upgradePaths[0].recovery = "existing-journal"; },
  "empty case matrix": c => { c.requiredCases.releasedAuth = []; },
  "consent case removed": c => { c.requiredCases.mixedAuth = c.requiredCases.mixedAuth.filter(x => x !== "repository-off"); },
  "runtime fault removed": c => { c.requiredCases.runtimeFaults.pop(); },
  "unimplemented case": c => { c.requiredCases.releasedAuth.push("unknown-case"); },
  "duplicate case": c => { c.requiredCases.releasedQueue = ["pending", "pending"]; },
  "backend stage omitted": c => { c.backendStages.pop(); },
  "unknown setting": c => { c.allowFailure = true; },
};
for (const [name, mutate] of Object.entries(mutations)) test(`contract rejects ${name}`, () => {
  const contract = load(); mutate(contract);
  assert.throws(() => validate(contract));
});

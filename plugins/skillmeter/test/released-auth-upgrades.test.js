"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {spawnSync} = require("node:child_process");
const {releasedCode} = require("./compatibility/released-code.cjs");
const contract = require("../../../.github/scripts/compatibility-contract.cjs").load();
const releases = contract.upgradePaths;
const candidate = path.resolve(__dirname, "..");
for (const release of releases) test(`released ${release.version} credentials -> candidate authorization`, async t => {
  const old = releasedCode(t, path.resolve(candidate, "../.."), release, "plugins/skillmeter");
  for (const scenario of contract.requiredCases.releasedAuth) {
    await t.test(scenario, t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "auth-upgrade-"));
      t.after(() => fs.rmSync(root, {recursive:true, force:true}));
      const result = spawnSync(process.execPath, [path.resolve(__dirname,"../../../test-support/auth-transition.cjs"), root, old, candidate, scenario], {
        encoding:"utf8", timeout:10000, env: {PATH:process.env.PATH, TMPDIR:os.tmpdir()},
      });
      assert.equal(result.status, 0, result.stderr || String(result.error));
    });
  }
});

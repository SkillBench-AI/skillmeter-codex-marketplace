"use strict";

/**
 * Unit tests for the shared org-scope resolver + narrowing helper used by both
 * the runtime repo-scope gate and the sign-in flow (SBEE org narrowing).
 *
 * Like the other suites, this isolates state by pointing HOME at a throwaway
 * dir before requiring any plugin module, and clears the env var between cases.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "sk-orgscope-home-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.SKILLMETER_REPO_SCOPE_ORGS;

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeOrgList, resolveOrgScope, narrowOrgsToScope } = require("../scripts/lib/org-scope");

// A throwaway project dir carrying .codex/settings.local.json with the given
// skillmeter settings object.
function makeProject(skillmeterSettings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sk-orgscope-proj-"));
  if (skillmeterSettings) {
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".codex", "settings.local.json"),
      JSON.stringify({ skillmeter: skillmeterSettings }) + "\n"
    );
  }
  return root;
}

test("normalizeOrgList lowercases, trims, dedupes, drops empties", () => {
  assert.deepEqual(
    normalizeOrgList(["  SkillBench-AI ", "acme", "ACME", "", null, 3]),
    ["skillbench-ai", "acme"]
  );
  assert.deepEqual(normalizeOrgList("not-an-array"), []);
});

test("resolveOrgScope returns null when nothing is configured", () => {
  assert.equal(resolveOrgScope({ cwd: makeProject(null) }), null);
});

test("resolveOrgScope: CLI orgs win over env and settings", () => {
  process.env.SKILLMETER_REPO_SCOPE_ORGS = "from-env";
  try {
    const cwd = makeProject({ repoScopeOrgs: ["from-settings"] });
    assert.deepEqual(
      resolveOrgScope({ cwd, cliOrgs: ["SkillBench-AI", "x"] }),
      ["skillbench-ai", "x"]
    );
  } finally {
    delete process.env.SKILLMETER_REPO_SCOPE_ORGS;
  }
});

test("resolveOrgScope: env wins over settings when no CLI orgs", () => {
  process.env.SKILLMETER_REPO_SCOPE_ORGS = "skillbench-ai, octocat";
  try {
    const cwd = makeProject({ repoScopeOrgs: ["from-settings"] });
    assert.deepEqual(resolveOrgScope({ cwd }), ["skillbench-ai", "octocat"]);
  } finally {
    delete process.env.SKILLMETER_REPO_SCOPE_ORGS;
  }
});

test("resolveOrgScope: per-project setting (array or string)", () => {
  assert.deepEqual(
    resolveOrgScope({ cwd: makeProject({ repoScopeOrgs: ["SkillBench-AI"] }) }),
    ["skillbench-ai"]
  );
  assert.deepEqual(
    resolveOrgScope({ cwd: makeProject({ repoScopeOrgs: "skillbench-ai, acme" }) }),
    ["skillbench-ai", "acme"]
  );
});

test("resolveOrgScope: empty CLI orgs fall through to env/settings", () => {
  const cwd = makeProject({ repoScopeOrgs: ["skillbench-ai"] });
  assert.deepEqual(resolveOrgScope({ cwd, cliOrgs: [] }), ["skillbench-ai"]);
});

test("narrowOrgsToScope: no scope keeps every fetched org", () => {
  const res = narrowOrgsToScope(["illgamhoduck", "skillbench-ai", "soma17th-ai17"], null);
  assert.equal(res.applied, false);
  assert.deepEqual(res.orgs, ["illgamhoduck", "skillbench-ai", "soma17th-ai17"]);
  assert.deepEqual(res.excluded, []);
});

test("narrowOrgsToScope: client's 10-org account narrowed to skillbench-ai", () => {
  const fetched = [
    "illgamhoduck",
    "bcaitech1",
    "boostcampaitech2",
    "boostcampaitech7",
    "skillbench-ai",
    "soma17th-ai17",
    "soma17th-ai16",
    "soma17th-ai18",
    "soma17th-ai20",
    "soma17th-ai19",
  ];
  const res = narrowOrgsToScope(fetched, ["skillbench-ai"]);
  assert.equal(res.applied, true);
  assert.deepEqual(res.orgs, ["skillbench-ai"]);
  assert.equal(res.excluded.length, 9);
});

test("narrowOrgsToScope: can only narrow — scope org you aren't in yields empty", () => {
  const res = narrowOrgsToScope(["acme"], ["skillbench-ai"]);
  assert.equal(res.applied, true);
  assert.deepEqual(res.orgs, []);
  assert.deepEqual(res.excluded, ["acme"]);
});

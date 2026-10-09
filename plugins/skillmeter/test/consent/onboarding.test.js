"use strict";
// Sign-in onboarding: repository discovery, one-write organization choices and
// the state line sign-in prints for the skill. Network sign-in is not exercised.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { PLUGIN_ROOT, tempDir, writeCredentials, license, makeRepo, writeSettings, consentPolicyFileIn } = require("../../test-support/plugin.cjs");
const { buildInventory, trustedProjectCwds, rolloutCwd } = require("../../scripts/lib/repository-inventory");

const ON = { enabled: true, decided_at: 1, source: "user", consent_version: 2 };

// A signed-in home whose Codex sessions ran in an acme repository, a second
// acme repository and a repository of an unlicensed owner.
function setup(t, { orgs = ["acme"] } = {}) {
  const home = tempDir("sk-onboard-home");
  const codexHome = path.join(home, ".codex");
  writeCredentials(home, { device_id: "DEV-1", hash_salt: "abcd", license_jwt: license({ orgs }), refresh_token: "synthetic-refresh" });
  const repos = {
    widgets: makeRepo({ remote: "git@github.com:acme/widgets.git" }),
    gears: makeRepo({ remote: "https://github.com/acme/gears.git" }),
    other: makeRepo({ remote: "git@github.com:other/tool.git" }),
  };
  const day = path.join(codexHome, "sessions", "2026", "10", "01");
  fs.mkdirSync(day, { recursive: true });
  for (const [name, root] of Object.entries({ widgets: repos.widgets, other: repos.other })) {
    fs.writeFileSync(path.join(day, `rollout-${name}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { cwd: root } }) + "\n" + JSON.stringify({ type: "event_msg" }) + "\n");
  }
  fs.writeFileSync(path.join(codexHome, "config.toml"), `model = "x"\n[projects."${repos.gears}"]\ntrust_level = "trusted"\n`);
  t.after(() => { for (const dir of [home, ...Object.values(repos)]) fs.rmSync(dir, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, PLUGIN_DATA: path.join(home, "data"),
    SKILLMETER_STATE_DIR: "", SKILLMETER_REPO_SCOPE_ORGS: "", SKILLMETER_BROKER_URL: "http://127.0.0.1:9" };
  const run = (script, args, cwd = home) => spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "scripts", script), ...args],
    { cwd, env, encoding: "utf8", timeout: 20000 });
  const cli = (args, cwd) => {
    const result = run("repository_telemetry.js", args, cwd);
    return { ...result, json: result.stdout.trim() ? JSON.parse(result.stdout) : null };
  };
  const policyFile = consentPolicyFileIn(path.join(home, ".skillbench"));
  const policy = () => JSON.parse(fs.readFileSync(policyFile, "utf8"));
  return { home, repos, run, cli, policy, policyFile };
}

test("list finds licensed repositories from sessions and trusted projects without paths", t => {
  const { cli, home } = setup(t);
  const result = cli(["list"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.revision, "absent");
  assert.deepEqual(result.json.orgs, [{ org: "acme", consent: null }]);
  assert.deepEqual(result.json.repositories.map(repo => [repo.key, repo.displayName, repo.consent, repo.effective]), [
    ["github.com/acme/gears", "@acme/gears", null, "off"],
    ["github.com/acme/widgets", "@acme/widgets", null, "off"],
  ]);
  assert.equal(result.stdout.includes(path.sep + path.basename(home)), false, "no local paths");
  assert.equal(result.stdout.includes("other/tool"), false, "unlicensed owners are left out");
});

test("onboard records organization and repositories ON in one revision, after acknowledgement only", t => {
  const { cli, policy, policyFile } = setup(t);
  const refused = cli(["onboard", "absent", "acme", "enabled", "github.com/acme/widgets"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /ACKNOWLEDGEMENT_REQUIRED/);
  assert.equal(fs.existsSync(policyFile), false);

  const result = cli(["onboard", "absent", "acme", "enabled", "github.com/acme/widgets", "github.com/acme/gears", "--acknowledge-machine-scope"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.revision, 1);
  assert.equal(result.json.consent, true);
  assert.deepEqual(result.json.results.map(repo => [repo.displayName, repo.effective]), [["@acme/gears", "on"], ["@acme/widgets", "on"]]);
  const saved = policy();
  assert.equal(saved.revision, 1);
  assert.equal(saved.organizations.acme.consent_version, 2);
  assert.equal(saved.repositories["github.com/acme/widgets"].consent_version, 2);
  assert.equal(saved.repositories["github.com/acme/gears"].enabled, true);
});

test("organization only authorizes the organization and records the listed repositories OFF", t => {
  const { cli, policy } = setup(t);
  const result = cli(["onboard", "absent", "acme", "disabled", "github.com/acme/widgets", "--acknowledge-machine-scope"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.json.results.map(repo => repo.effective), ["off"]);
  const saved = policy();
  assert.equal(saved.organizations.acme.enabled, true);
  assert.equal(saved.repositories["github.com/acme/widgets"].enabled, false);
  assert.equal("consent_version" in saved.repositories["github.com/acme/widgets"], false);
});

test("a changed revision is reported as stale and nothing is written", t => {
  const { cli, policy } = setup(t);
  assert.equal(cli(["org", "absent", "acme", "disabled"]).status, 0);
  const stale = cli(["onboard", "absent", "acme", "enabled", "github.com/acme/widgets", "--acknowledge-machine-scope"]);
  assert.equal(stale.status, 0, stale.stderr);
  assert.deepEqual(stale.json, { stale: true, revision: 1 });
  assert.equal(policy().organizations.acme.enabled, false);
});

test("only repositories of the named organization from a fresh list can be chosen", t => {
  const { cli, policyFile } = setup(t, { orgs: ["acme", "beta"] });
  for (const key of ["github.com/other/tool", "github.com/beta/widgets", "github.com/acme/unknown"]) {
    const result = cli(["onboard", "absent", "acme", "enabled", key, "--acknowledge-machine-scope"]);
    assert.equal(result.status, 1, key);
    assert.match(result.stderr, /REPOSITORY_CHANGED/);
  }
  const foreign = cli(["org", "absent", "other", "enabled", "--acknowledge-machine-scope"]);
  assert.match(foreign.stderr, /ORGANIZATION_UNAVAILABLE/);
  assert.equal(fs.existsSync(policyFile), false);
});

test("a checkout with a local OFF is flagged and cannot be turned on by onboarding", t => {
  const { cli, repos, policyFile } = setup(t);
  writeSettings(repos.widgets, { telemetry: false });
  const listed = cli(["list"]).json.repositories.find(repo => repo.key === "github.com/acme/widgets");
  assert.equal(listed.localRestriction, true);
  const result = cli(["onboard", "absent", "acme", "enabled", "github.com/acme/widgets", "--acknowledge-machine-scope"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LOCAL_CONSENT_CONFLICT/);
  assert.equal(fs.existsSync(policyFile), false);
});

test("sign-in prints the organization state line after the welcome banner", t => {
  const { run, cli } = setup(t);
  const state = () => {
    const result = run("signin.js", []);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /signed in/);
    const line = result.stdout.split("\n").indexOf("SkillMeter sign-in state JSON:");
    assert.notEqual(line, -1, result.stdout);
    return JSON.parse(result.stdout.split("\n")[line + 1]);
  };
  assert.deepEqual(state(), { status: "signed_in", globalPaused: false, orgs: [{ org: "acme", consent: null }] });
  assert.match(run("signin.js", []).stdout, /\[ TELEMETRY SETUP \][\s\S]*\[ REPOSITORY REVIEW \][\s\S]*○ OFF +@acme\/gears/);
  cli(["org", "absent", "acme", "enabled", "--acknowledge-machine-scope"]);
  assert.deepEqual(state().orgs, [{ org: "acme", consent: true }]);
  assert.match(run("signin.js", []).stdout, /\[ ORGANIZATION ON \][\s\S]*ON for 0 of 2 local repositories/);
});

test("an ON choice without the Codex acknowledgement still needs a choice", () => {
  const scope = key => ({ allowed: true, repoKey: key, remoteOrg: key.split("/")[1] });
  const inventory = buildInventory({
    roots: ["github.com/acme/a", "github.com/acme/b"],
    allowedOrgs: ["acme"],
    policy: { revision: 4, global: { enabled: false },
      organizations: { acme: { enabled: true, decided_at: 1 } },
      repositories: { "github.com/acme/a": ON, "github.com/acme/c": { enabled: false, decided_at: 1 } } },
    getScope: scope,
    getLocalChoice: () => "unset",
    globalPaused: true,
  });
  assert.deepEqual(inventory.orgs, [{ org: "acme", consent: null }]);
  assert.deepEqual(inventory.repositories.map(repo => [repo.key, repo.consent, repo.effective]), [
    ["github.com/acme/a", true, "off"],
    ["github.com/acme/b", null, "off"],
    ["github.com/acme/c", false, "off"],
  ]);
});

test("discovery reads only absolute session and project paths", () => {
  const dir = tempDir("sk-onboard-files");
  const config = path.join(dir, "config.toml");
  fs.writeFileSync(config, `[projects."/abs/one"]\n[projects.'/abs/two']\n[projects."relative"]\n[profiles.x]\n`);
  assert.deepEqual(trustedProjectCwds(config), ["/abs/one", "/abs/two"]);
  const rollout = path.join(dir, "rollout-a.jsonl");
  fs.writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { cwd: "/abs/one", base_instructions: "x".repeat(200_000) } }) + "\n");
  assert.equal(rolloutCwd(rollout), "/abs/one");
  fs.writeFileSync(rollout, JSON.stringify({ type: "event_msg", payload: { cwd: "/abs/one" } }) + "\n");
  assert.equal(rolloutCwd(rollout), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

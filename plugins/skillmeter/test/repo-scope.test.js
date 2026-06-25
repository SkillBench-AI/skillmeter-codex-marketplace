"use strict";

/**
 * Unit tests for the default privacy posture / repo-scope gating (SBEE-153).
 * Run with:  node --test plugins/skillmeter/test/repo-scope.test.js
 *
 * Like auth.test.js, these isolate state by pointing HOME at a throwaway dir
 * (so the shared ~/.skillbench/credentials.json is never touched) and seeding
 * a device id + hash salt up front so credstore never reaches for the macOS
 * Keychain. This MUST happen before credstore/logger are required, since
 * CRED_FILE is resolved from os.homedir() at module load.
 *
 * The contract under test mirrors the Claude plugin exactly: with no signed-in
 * orgs every event is dropped (`not_activated`); there is no permissive
 * allow-all default and no per-project allow-list.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "sk-scope-home-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

fs.mkdirSync(path.join(tmpHome, ".skillbench"), { recursive: true });
fs.writeFileSync(
  path.join(tmpHome, ".skillbench", "credentials.json"),
  JSON.stringify({ device_id: "TEST-DEVICE", hash_salt: "deadbeef" }) + "\n"
);

const { test } = require("node:test");
const assert = require("node:assert/strict");

const credstore = require("../scripts/credstore");
const logger = require("../scripts/logger");

// --- helpers ---------------------------------------------------------------

// Allowed orgs live in credstore (captured at signin), so we drive scope state
// through the same lifecycle the real signin flow uses.
function signInWithOrgs(orgs) {
  credstore.markEngaged();
  assert.equal(credstore.commitSignin({ jwt: "a.b.c", orgs }), true);
}

function signOut() {
  credstore.signOut();
}

// Build a throwaway git repo whose .git/config carries the given remote URL.
// Pass null for `remoteUrl` to create a repo with no remote at all.
function makeRepo(remoteUrl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sk-scope-repo-"));
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  const config = remoteUrl
    ? `[remote "origin"]\n\turl = ${remoteUrl}\n`
    : "[core]\n\tbare = false\n";
  fs.writeFileSync(path.join(root, ".git", "config"), config);
  return root;
}

// A directory that is NOT inside any git repo.
function makeNonRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sk-scope-plain-"));
}

// --- not_activated: the default closed posture -----------------------------

test("no signed-in orgs => not_activated, events dropped (even in an allowed-looking repo)", () => {
  signOut();
  assert.deepEqual(credstore.getAllowedGitHubOrgs(), []);

  const repo = makeRepo("git@github.com:acme/widgets.git");
  const decision = logger.getRepoScopeDecision(repo);
  assert.equal(decision.allowed, false);
  assert.equal(decision.classification, "not_activated");
});

test("signed in but with zero orgs cached => not_activated", () => {
  signInWithOrgs([]);
  const repo = makeRepo("git@github.com:acme/widgets.git");
  const decision = logger.getRepoScopeDecision(repo);
  assert.equal(decision.allowed, false);
  assert.equal(decision.classification, "not_activated");
});

// --- activated: gate by GitHub org membership ------------------------------

test("remote in an allowed org => approved", () => {
  signInWithOrgs(["acme", "octocat"]);
  const repo = makeRepo("git@github.com:acme/widgets.git");
  const decision = logger.getRepoScopeDecision(repo);
  assert.equal(decision.allowed, true);
  assert.equal(decision.scope, "approved");
  assert.equal(decision.classification, "github_org_match");
  assert.equal(decision.remoteOrg, "acme");
});

test("remote org match is case-insensitive and works for https remotes", () => {
  signInWithOrgs(["acme"]);
  const repo = makeRepo("https://github.com/ACME/widgets.git");
  const decision = logger.getRepoScopeDecision(repo);
  assert.equal(decision.allowed, true);
  assert.equal(decision.classification, "github_org_match");
});

test("remote in a non-member org => github_org_mismatch, dropped", () => {
  signInWithOrgs(["acme"]);
  const repo = makeRepo("git@github.com:someoneelse/widgets.git");
  const decision = logger.getRepoScopeDecision(repo);
  assert.equal(decision.allowed, false);
  assert.equal(decision.scope, "external");
  assert.equal(decision.classification, "github_org_mismatch");
  assert.equal(decision.remoteOrg, "someoneelse");
});

test("git repo with no GitHub remote => no_github_remote, dropped", () => {
  signInWithOrgs(["acme"]);
  const repo = makeRepo("https://gitlab.com/acme/widgets.git");
  const decision = logger.getRepoScopeDecision(repo);
  assert.equal(decision.allowed, false);
  assert.equal(decision.classification, "no_github_remote");
});

test("git repo with no remote at all => no_github_remote, dropped", () => {
  signInWithOrgs(["acme"]);
  const repo = makeRepo(null);
  const decision = logger.getRepoScopeDecision(repo);
  assert.equal(decision.allowed, false);
  assert.equal(decision.classification, "no_github_remote");
});

test("directory outside any git repo => no_repository, dropped", () => {
  signInWithOrgs(["acme"]);
  const plain = makeNonRepo();
  const decision = logger.getRepoScopeDecision(plain);
  assert.equal(decision.allowed, false);
  assert.equal(decision.classification, "no_repository");
});

// --- org-filter narrowing (intersection with signed-in orgs) ---------------

// Write skillmeter.repoScopeOrgs into a repo's .codex/settings.local.json so the
// per-project resolution path can be exercised.
function writeRepoScopeSetting(repoRoot, value) {
  const dir = path.join(repoRoot, ".codex");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "settings.local.json"),
    JSON.stringify({ skillmeter: { repoScopeOrgs: value } }) + "\n"
  );
}

test("env filter narrows multi-org account to a single org => other member org dropped", () => {
  signInWithOrgs(["skillbench-ai", "acme"]);
  process.env.SKILLMETER_REPO_SCOPE_ORGS = "skillbench-ai";
  try {
    const inScope = logger.getRepoScopeDecision(
      makeRepo("git@github.com:skillbench-ai/widgets.git")
    );
    assert.equal(inScope.allowed, true);
    assert.equal(inScope.classification, "github_org_match");
    assert.equal(inScope.remoteOrg, "skillbench-ai");

    // acme is still a signed-in org, but the filter excludes it.
    const filteredOut = logger.getRepoScopeDecision(
      makeRepo("git@github.com:acme/widgets.git")
    );
    assert.equal(filteredOut.allowed, false);
    assert.equal(filteredOut.classification, "github_org_mismatch");
    assert.equal(filteredOut.remoteOrg, "acme");
  } finally {
    delete process.env.SKILLMETER_REPO_SCOPE_ORGS;
  }
});

test("env filter is case-insensitive and accepts comma/space-separated lists", () => {
  signInWithOrgs(["skillbench-ai", "acme"]);
  process.env.SKILLMETER_REPO_SCOPE_ORGS = "SkillBench-AI, octocat";
  try {
    const decision = logger.getRepoScopeDecision(
      makeRepo("https://github.com/SKILLBENCH-AI/widgets.git")
    );
    assert.equal(decision.allowed, true);
    assert.equal(decision.classification, "github_org_match");
  } finally {
    delete process.env.SKILLMETER_REPO_SCOPE_ORGS;
  }
});

test("filter can only narrow, never widen: a non-member org stays blocked", () => {
  signInWithOrgs(["acme"]);
  process.env.SKILLMETER_REPO_SCOPE_ORGS = "skillbench-ai";
  try {
    // skillbench-ai is on the filter but NOT a signed-in org, so the
    // intersection is empty and the repo is out of scope.
    const decision = logger.getRepoScopeDecision(
      makeRepo("git@github.com:skillbench-ai/widgets.git")
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.classification, "github_org_mismatch");
  } finally {
    delete process.env.SKILLMETER_REPO_SCOPE_ORGS;
  }
});

test("per-project repoScopeOrgs array narrows scope", () => {
  signInWithOrgs(["skillbench-ai", "acme"]);
  const repo = makeRepo("git@github.com:skillbench-ai/widgets.git");
  writeRepoScopeSetting(repo, ["skillbench-ai"]);
  const decision = logger.getRepoScopeDecision(repo);
  assert.equal(decision.allowed, true);
  assert.equal(decision.classification, "github_org_match");

  const otherOrgRepo = makeRepo("git@github.com:acme/widgets.git");
  writeRepoScopeSetting(otherOrgRepo, ["skillbench-ai"]);
  const dropped = logger.getRepoScopeDecision(otherOrgRepo);
  assert.equal(dropped.allowed, false);
  assert.equal(dropped.classification, "github_org_mismatch");
});

test("per-project repoScopeOrgs accepts a comma-separated string", () => {
  signInWithOrgs(["skillbench-ai", "acme"]);
  const repo = makeRepo("git@github.com:skillbench-ai/widgets.git");
  writeRepoScopeSetting(repo, "skillbench-ai, octocat");
  const decision = logger.getRepoScopeDecision(repo);
  assert.equal(decision.allowed, true);
  assert.equal(decision.classification, "github_org_match");
});

test("env filter takes precedence over the per-project setting", () => {
  signInWithOrgs(["skillbench-ai", "acme"]);
  const repo = makeRepo("git@github.com:acme/widgets.git");
  // Per-project allows acme, but the env filter restricts to skillbench-ai.
  writeRepoScopeSetting(repo, ["acme"]);
  process.env.SKILLMETER_REPO_SCOPE_ORGS = "skillbench-ai";
  try {
    const decision = logger.getRepoScopeDecision(repo);
    assert.equal(decision.allowed, false);
    assert.equal(decision.classification, "github_org_mismatch");
  } finally {
    delete process.env.SKILLMETER_REPO_SCOPE_ORGS;
  }
});

test("an empty/whitespace filter is ignored => all signed-in orgs allowed", () => {
  signInWithOrgs(["acme"]);
  process.env.SKILLMETER_REPO_SCOPE_ORGS = "   ";
  try {
    assert.equal(logger.getRepoScopeOrgFilter(makeNonRepo()), null);
    const decision = logger.getRepoScopeDecision(
      makeRepo("git@github.com:acme/widgets.git")
    );
    assert.equal(decision.allowed, true);
    assert.equal(decision.classification, "github_org_match");
  } finally {
    delete process.env.SKILLMETER_REPO_SCOPE_ORGS;
  }
});

"use strict";

/**
 * Repository eligibility tests with temporary HOME and seeded credentials.
 * No stored identities means no capture; configured scope can only narrow access.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "sk-scope-home-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.PLUGIN_DATA = path.join(tmpHome, "plugin-data");

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

// Real Git layouts catch differences that hand-written .git/config fixtures miss.
function makeWorktree(t, remoteUrl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sk-scope-worktree-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "main");
  const worktree = path.join(root, "linked");
  const git = (...args) => execFileSync("git", args, {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, stdio: "pipe",
  }).toString().trim();
  git("init", "-q", repo);
  git("-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
    "commit", "--allow-empty", "-qm", "fixture");
  git("-C", repo, "remote", "add", "origin", remoteUrl);
  git("-C", repo, "worktree", "add", "--detach", worktree);
  const gitDir = git("-C", worktree, "rev-parse", "--absolute-git-dir");
  return { repo, worktree, gitDir };
}

for (const absolute of [false, true]) {
  test(`linked worktree uses ${absolute ? "absolute" : "relative"} commondir remote`, (t) => {
    signInWithOrgs(["acme"]);
    const { repo, worktree, gitDir } = makeWorktree(t, "https://github.com/acme/widgets.git");
    const commonFile = path.join(gitDir, "commondir");
    assert.equal(path.isAbsolute(fs.readFileSync(commonFile, "utf8").trim()), false);
    if (absolute) fs.writeFileSync(commonFile, path.join(repo, ".git") + "\n");
    // A relative gitdir pointer is also valid; resolve it from the worktree root.
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.relative(worktree, gitDir)}\n`);
    const nested = path.join(worktree, "src");
    fs.mkdirSync(nested);
    assert.deepEqual(logger.getRepoScopeDecision(nested), {
      ...logger.getRepoScopeDecision(repo), repoRoot: worktree,
    });
    assert.equal(logger.getRepoScopeDecision(nested).allowed, true);
  });
}

test("linked worktree outside signed-in orgs remains blocked", (t) => {
  signInWithOrgs(["acme"]);
  const { repo, worktree } = makeWorktree(t, "https://github.com/other/widgets.git");
  assert.deepEqual(logger.getRepoScopeDecision(worktree), {
    ...logger.getRepoScopeDecision(repo), repoRoot: worktree,
  });
  assert.equal(logger.getRepoScopeDecision(worktree).allowed, false);
});

test("linked worktree still honors the project org filter", (t) => {
  signInWithOrgs(["acme", "other"]);
  const { worktree } = makeWorktree(t, "https://github.com/acme/widgets.git");
  writeRepoScopeSetting(worktree, ["other"]);
  const decision = logger.getRepoScopeDecision(worktree);
  assert.equal(decision.allowed, false);
  assert.equal(decision.classification, "github_org_mismatch");
});

for (const broken of ["missing-common-directory", "missing-config", "unreadable-commondir", "empty-commondir"]) {
  test(`linked worktree fails closed with ${broken}`, (t) => {
    signInWithOrgs(["acme"]);
    const { repo, worktree, gitDir } = makeWorktree(t, "https://github.com/acme/widgets.git");
    const commonFile = path.join(gitDir, "commondir");
    if (broken === "missing-common-directory") fs.writeFileSync(commonFile, "missing\n");
    if (broken === "empty-commondir") fs.writeFileSync(commonFile, "\n");
    if (broken === "missing-config") fs.unlinkSync(path.join(repo, ".git", "config"));
    if (broken === "unreadable-commondir") {
      fs.unlinkSync(commonFile);
      fs.mkdirSync(commonFile);
    }
    // Never fall back to a private config when shared metadata is invalid.
    fs.writeFileSync(path.join(gitDir, "config"), '[remote "origin"]\nurl = https://github.com/acme/widgets.git\n');
    const decision = logger.getRepoScopeDecision(worktree);
    assert.equal(decision.allowed, false);
    assert.equal(decision.classification, "no_github_remote");
  });
}

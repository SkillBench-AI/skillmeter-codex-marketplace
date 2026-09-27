"use strict";

// Promotion changes only a Git ref. It never executes the candidate's code.
const { execFileSync } = require("node:child_process");
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/;
function requireThat(condition, reason) { if (!condition) throw Error(reason); }
function compareVersions(a, b) {
  requireThat(VERSION.test(a) && VERSION.test(b), "invalid-version");
  const aa = a.split(".").map(BigInt), bb = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}
function rulesets(appId) {
  requireThat(Number.isSafeInteger(appId) && appId > 0 && appId !== 15368, "dedicated-publisher-required");
  const base = { target: "branch", enforcement: "active", conditions: { ref_name: { include: ["refs/heads/stable"], exclude: [] } } };
  return [
    { ...base, name: "stable-promotion", bypass_actors: [{ actor_id: appId, actor_type: "Integration", bypass_mode: "always" }], rules: [{ type: "creation" }, { type: "update", parameters: { update_allows_fetch_and_merge: false } }] },
    { ...base, name: "stable-integrity", bypass_actors: [], rules: [{ type: "deletion" }, { type: "non_fast_forward" }] },
  ];
}
function checkProtections(allRules, environment, branches, appId) {
  const has = (expected) => allRules.some(r => r.enforcement === "active" && r.target === expected.target &&
    r.conditions?.ref_name?.include?.length === 1 && r.conditions.ref_name.include[0] === "refs/heads/stable" &&
    r.conditions.ref_name.exclude?.length === 0 &&
    (r.bypass_actors ?? []).length === expected.bypass_actors.length &&
    expected.bypass_actors.every(e => r.bypass_actors.some(a => a.actor_id === e.actor_id && a.actor_type === e.actor_type && a.bypass_mode === e.bypass_mode)) &&
    expected.rules.every(e => r.rules?.some(a => a.type === e.type &&
      (e.type !== "update" || a.parameters?.update_allows_fetch_and_merge === false))));
  for (const rule of rulesets(appId)) requireThat(has(rule), `missing-${rule.name}-protection`);
  requireThat(allRules.some(r => r.enforcement === "active" && r.target === "tag" &&
    r.conditions?.ref_name?.include?.length === 1 && r.conditions.ref_name.include[0] === "refs/tags/v*" &&
    r.conditions.ref_name.exclude?.length === 0 && (r.bypass_actors ?? []).length === 0 &&
    ["update", "deletion"].every(type => r.rules?.some(a => a.type === type))), "immutable-release-tags-required");
  requireThat(environment.can_admins_bypass === false && environment.deployment_branch_policy?.custom_branch_policies === true &&
    environment.deployment_branch_policy.protected_branches === false &&
    environment.protection_rules?.some(r => r.type === "required_reviewers" && r.prevent_self_review === true && r.reviewers?.length > 0), "protected-publisher-environment-required");
  requireThat(branches.total_count === 1 && branches.branch_policies?.length === 1 &&
    branches.branch_policies[0].name === "main" && branches.branch_policies[0].type === "branch", "publisher-main-only-required");
}
function inputs(env) {
  const repo = env.GITHUB_REPOSITORY;
  requireThat(typeof repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo), "invalid-repository");
  requireThat(env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.GITHUB_REF === "refs/heads/main", "dispatch-main-only");
  requireThat(/^v/.test(env.RELEASE_TAG ?? "") && VERSION.test(env.RELEASE_TAG.slice(1)), "invalid-tag");
  requireThat(SHA.test(env.RELEASE_SHA ?? ""), "full-release-sha-required");
  requireThat(env.EXPECTED_STABLE === "absent" || SHA.test(env.EXPECTED_STABLE ?? ""), "expected-stable-required");
  requireThat(/^[1-9]\d*$/.test(env.RELEASE_RUN_ID ?? ""), "release-run-required");
  // The link is a reviewer attestation, not an automatically proven smoke test.
  const prefix = `https://github.com/${repo}/`;
  requireThat(typeof env.SMOKE_EVIDENCE_URL === "string" && env.SMOKE_EVIDENCE_URL.startsWith(prefix) &&
    /^(actions\/runs\/[1-9]\d*|pull\/[1-9]\d*#issuecomment-\d+|issues\/[1-9]\d*#issuecomment-\d+)$/.test(env.SMOKE_EVIDENCE_URL.slice(prefix.length)), "smoke-evidence-link-required");
  const appId = Number(env.RELEASE_APP_ID);
  rulesets(appId);
  return { repo, tag: env.RELEASE_TAG, sha: env.RELEASE_SHA, previous: env.EXPECTED_STABLE, runId: env.RELEASE_RUN_ID, appId, evidence: env.SMOKE_EVIDENCE_URL };
}
function githubApi(path, method = "GET", body) {
  const args = ["api", path, "--method", method];
  if (body !== undefined) args.push("--input", "-");
  const env = { ...process.env };
  if (method !== "GET") {
    requireThat(Boolean(env.STABLE_PUBLISH_TOKEN), "publisher-token-required");
    env.GH_TOKEN = env.STABLE_PUBLISH_TOKEN;
  }
  delete env.STABLE_PUBLISH_TOKEN;
  return JSON.parse(execFileSync("gh", args, { env, input: body === undefined ? undefined : JSON.stringify(body), encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }));
}
function inspect(env, api = githubApi) {
  const c = inputs(env), root = `repos/${c.repo}`;
  const details = [];
  for (let page = 1; ; page++) {
    const list = api(`${root}/rulesets?includes_parents=true&per_page=100&page=${page}`);
    requireThat(Array.isArray(list), "rules-unavailable");
    for (const row of list) {
      // Repository rules suffice; inherited restrictions still apply server-side.
      if (row.source_type === "Repository") details.push(api(`${root}/rulesets/${row.id}`));
    }
    if (list.length < 100) break;
  }
  checkProtections(details, api(`${root}/environments/release-publisher`), api(`${root}/environments/release-publisher/deployment-branch-policies?per_page=100`), c.appId);
  let object = api(`${root}/git/ref/tags/${c.tag}`).object;
  for (let depth = 0; object.type === "tag" && depth < 4; depth++) object = api(`${root}/git/tags/${object.sha}`).object;
  requireThat(object.type === "commit" && object.sha === c.sha, "tag-candidate-mismatch");
  const manifest = (sha) => {
    const blob = api(`${root}/contents/plugins/skillmeter/.codex-plugin/plugin.json?ref=${sha}`);
    requireThat(blob.encoding === "base64", "manifest-unavailable");
    return JSON.parse(Buffer.from(blob.content, "base64").toString("utf8"));
  };
  const version = manifest(c.sha).version;
  requireThat(c.tag === `v${version}` && VERSION.test(version), "tag-version-mismatch");
  const main = api(`${root}/git/ref/heads/main`).object.sha;
  requireThat(SHA.test(main), "invalid-main");
  requireThat(["ahead", "identical"].includes(api(`${root}/compare/${c.sha}...${main}`).status), "candidate-not-on-main");
  const release = api(`${root}/releases/tags/${c.tag}`);
  requireThat(release.tag_name === c.tag && release.draft === false && release.prerelease === false && Boolean(release.published_at), "published-release-required");
  requireThat(release.assets?.some(a => a.name === `skillmeter-codex-marketplace-${c.tag}.tar.gz` && a.state === "uploaded" && a.size > 0), "release-archive-required");
  const run = api(`${root}/actions/runs/${c.runId}`);
  requireThat(run.repository?.full_name === c.repo && run.head_repository?.full_name === c.repo &&
    run.path === ".github/workflows/release.yml" && run.head_sha === c.sha && run.status === "completed" && run.conclusion === "success" &&
    ((run.event === "push" && run.head_branch === c.tag) || (run.event === "workflow_dispatch" && run.head_branch === "main")), "successful-release-run-required");
  const refs = api(`${root}/git/matching-refs/heads/stable`);
  requireThat(Array.isArray(refs), "stable-unavailable");
  const ref = refs.find(r => r.ref === "refs/heads/stable");
  const previous = ref?.object.sha ?? "absent";
  requireThat(previous === c.previous, "stable-changed-reinspect");
  if (previous !== "absent") {
    requireThat(SHA.test(previous), "invalid-stable-sha");
    requireThat(previous === c.sha || compareVersions(version, manifest(previous).version) > 0, "version-must-increase");
    requireThat(["ahead", "identical"].includes(api(`${root}/compare/${previous}...${c.sha}`).status), "stable-fast-forward-required");
  }
  return { ...c, version, noop: previous === c.sha, status: "eligible-pending-reviewed-smoke" };
}
function promote(env, api = githubApi) {
  // Re-read all evidence after environment approval/token creation.
  const c = inspect(env, api), root = `repos/${c.repo}`;
  if (!c.noop) {
    if (c.previous === "absent") api(`${root}/git/refs`, "POST", { ref: "refs/heads/stable", sha: c.sha });
    else api(`${root}/git/refs/heads/stable`, "PATCH", { sha: c.sha, force: false });
  }
  requireThat(api(`${root}/git/ref/heads/stable`).object.sha === c.sha, "promotion-not-observed");
  return { ...c, status: "promoted" };
}
module.exports = { compareVersions, rulesets, checkProtections, inputs, inspect, promote };
if (require.main === module) {
  try {
    const command = process.argv[2];
    const result = command === "rules" ? rulesets(Number(process.argv[3])) :
      command === "check" ? inspect(process.env) : command === "promote" ? promote(process.env) : null;
    requireThat(result, "usage: stable-channel.cjs rules APP_ID | check | promote");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(`stable-channel: ${error.message}`); process.exitCode = 1; }
}

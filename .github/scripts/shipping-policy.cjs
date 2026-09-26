"use strict";
const fs = require("node:fs");
const {execFileSync} = require("node:child_process");
const {revision, keys} = require("./compatibility-contract.cjs");
const check = (ok, reason) => { if (!ok) throw Error(reason); };
const ENVIRONMENT = "compatibility-reviewed";
function dependencies(value) {
  check(keys(value,["version","claude","collector","pipeline"]) && value.version === 1 && [value.claude,value.collector,value.pipeline].every(revision), "invalid-dependency-pins");
  return value;
}
function target(context, allowPullRequest = false) {
  const {eventName, ref, sha, event, repository} = context;
  check(revision(sha) && event?.repository?.full_name === repository, "invalid-shipping-context");
  if (eventName === "merge_group") {
    check(event.action === "checks_requested" && event.merge_group?.head_sha === sha && event.merge_group?.base_ref === "refs/heads/main" && revision(event.merge_group?.base_sha) && event.merge_group?.head_ref === ref && ref.startsWith("refs/heads/gh-readonly-queue/main/"), "invalid-merge-candidate");
    return "merge-candidate";
  }
  if (eventName === "workflow_dispatch") {
    check(ref === "refs/heads/main", "release-requires-main");
    return "main-candidate";
  }
  if (allowPullRequest && eventName === "pull_request") {
    check(event.pull_request?.base?.repo?.full_name === repository, "invalid-pull-request");
    return "queue-admission-only";
  }
  throw Error("unsupported-shipping-event");
}
function protectedEnvironment(value, policies, name = ENVIRONMENT) {
  check([ENVIRONMENT,"release-publisher"].includes(name), "unknown-protected-environment");
  const branches = name === ENVIRONMENT ? ["main","gh-readonly-queue/main/*"] : ["main"];
  const review = value?.protection_rules?.find(rule=>rule.type === "required_reviewers");
  check(value?.name === name && review?.prevent_self_review === true && Array.isArray(review.reviewers) && review.reviewers.length > 0 && value.can_admins_bypass === false, "protected-review-environment-required");
  check(value.deployment_branch_policy?.custom_branch_policies === true && value.deployment_branch_policy.protected_branches === false, "restricted-environment-branches-required");
  check(policies?.total_count === branches.length && Array.isArray(policies.branch_policies) && policies.branch_policies.length === branches.length && policies.branch_policies.every(p=>p.type === "branch") && new Set(policies.branch_policies.map(p=>p.name)).size === branches.length && policies.branch_policies.every(p=>branches.includes(p.name)), "restricted-environment-branches-required");
}
function decision(mode, preparation, compatibility, verified, expected) {
  check(preparation === "success", "shipping-preparation-failed");
  if (mode === "queue-admission-only") {
    check(compatibility === "skipped", "unexpected-private-pr-execution");
    return "queue-admission-only";
  }
  check(["merge-candidate","main-candidate"].includes(mode), "unsupported-shipping-mode");
  check(compatibility === "success", "compatibility-not-successful");
  check(revision(expected) && verified === expected, "shipping-revision-mismatch");
  return "verified-candidate";
}
function publication(verified, head, main, tag, verifiedAt, now = Date.now()) {
  const accepted = typeof verifiedAt === "string" ? Date.parse(verifiedAt) : NaN;
  check(Number.isFinite(accepted) && accepted <= now && now - accepted <= 60 * 60 * 1000, "release-evidence-expired");
  check(revision(verified) && verified === head && verified === main, "release-candidate-changed");
  check(!tag || tag === verified, "release-tag-mismatch");
}
module.exports = {dependencies,target,protectedEnvironment,decision,publication,ENVIRONMENT};
if (require.main === module) {
  try {
    const read = file => JSON.parse(fs.readFileSync(file,"utf8"));
    const context = () => ({eventName:process.env.GITHUB_EVENT_NAME,ref:process.env.GITHUB_REF,sha:process.env.GITHUB_SHA,repository:process.env.GITHUB_REPOSITORY,event:read(process.env.GITHUB_EVENT_PATH)});
    const git = (...args) => execFileSync("git",args,{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
    const command = process.argv[2];
    if (command === "prepare") {
      const mode = target(context(), process.argv.includes("--allow-pr"));
      check(git("rev-parse","HEAD") === process.env.GITHUB_SHA, "checkout-revision-mismatch");
      dependencies(read("compatibility/dependencies.json"));
      if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,`mode=${mode}\n`);
      console.log(mode);
    } else if (command === "environment") {
      protectedEnvironment(read(process.argv[3]),read(process.argv[4]),process.argv[5]);
    } else if (command === "decide") {
      console.log(decision(process.env.SHIPPING_MODE,process.env.PREPARATION_RESULT,process.env.COMPATIBILITY_RESULT,process.env.VERIFIED_SHA,process.env.GITHUB_SHA));
    } else if (command === "publish") {
      check(target(context()) === "main-candidate", "release-requires-main");
      const main = git("ls-remote","origin","refs/heads/main").split(/\s/)[0];
      const version = read("plugins/skillmeter/.codex-plugin/plugin.json").version;
      check(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version),"invalid-release-version");
      const tag = "v" + version;
      let existing = null;
      const remoteTags = git("ls-remote","origin",`refs/tags/${tag}`,`refs/tags/${tag}^{}`).split("\n").filter(Boolean).map(line=>line.split(/\s+/));
      if (remoteTags.length) existing = (remoteTags.find(row=>row[1].endsWith("^{}")) || remoteTags[0])[0];
      publication(process.env.VERIFIED_SHA,git("rev-parse","HEAD"),main,existing,process.env.VERIFIED_AT);
      fs.appendFileSync(process.env.GITHUB_OUTPUT,`tag=${tag}\nexisting=${Boolean(existing)}\n`);
    } else throw Error("unknown-shipping-command");
  } catch (error) {
    console.error(/^[a-z]+(?:-[a-z]+)+$/.test(error.message) ? error.message : "shipping-policy-failed");
    process.exitCode=1;
  }
}

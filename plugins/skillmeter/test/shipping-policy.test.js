"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawnSync,execFileSync} = require("node:child_process");
const {dependencies,target,protectedEnvironment,decision,publication} = require("../../../.github/scripts/shipping-policy.cjs");
const {rulesets,CHECKS_APP} = require("../../../.github/scripts/shipping-rules.cjs");
const sha="a".repeat(40), other="b".repeat(40), repository="example/plugin";
const base = () => ({sha,repository,event:{repository:{full_name:repository}}});
const queue = () => ({...base(),eventName:"merge_group",ref:"refs/heads/gh-readonly-queue/main/pr-1-abc",event:{...base().event,action:"checks_requested",merge_group:{head_sha:sha,base_sha:other,base_ref:"refs/heads/main",head_ref:"refs/heads/gh-readonly-queue/main/pr-1-abc"}}});
const pr = () => ({...base(),eventName:"pull_request",ref:"refs/pull/1/merge",event:{...base().event,pull_request:{base:{repo:{full_name:repository}}}}});
const main = () => ({...base(),eventName:"workflow_dispatch",ref:"refs/heads/main"});
const environment = (name="compatibility-reviewed") => ({name,can_admins_bypass:false,protection_rules:[{type:"required_reviewers",prevent_self_review:true,reviewers:[{type:"Team",reviewer:{id:1}}]}],deployment_branch_policy:{custom_branch_policies:true,protected_branches:false}});
const policies = (names=["main","gh-readonly-queue/main/*"]) => ({total_count:names.length,branch_policies:names.map(name=>({name,type:"branch"}))});

test("PR admission cannot authorize private execution or publication",()=>{
  assert.equal(target(pr(),true),"queue-admission-only");
  assert.throws(()=>target(pr()),/unsupported-shipping-event/);
  assert.equal(decision(target(pr(),true),"success","skipped","",sha),"queue-admission-only");
  assert.throws(()=>decision(target(pr(),true),"success","success",sha,sha),/unexpected-private-pr-execution/);
});
test("queue execution is bound to the combined candidate and main base",()=>{
  assert.equal(target(queue()),"merge-candidate");
  for (const [key,value] of [["head_sha",other],["base_ref","refs/heads/other"],["base_sha","main"],["head_ref","refs/heads/another"]]) {
    const input=queue();input.event.merge_group[key]=value;
    assert.throws(()=>target(input),/invalid-merge-candidate/,key);
  }
  const input=queue(); input.ref=input.event.merge_group.head_ref="refs/heads/attacker";
  assert.throws(()=>target(input),/invalid-merge-candidate/);
  const removed=queue();removed.event.action="destroyed";
  assert.throws(()=>target(removed),/invalid-merge-candidate/);
});
test("only main dispatch or checked queue candidates can run private compatibility",()=>{
  assert.equal(target(main()),"main-candidate");
  for (const input of [{...main(),ref:"refs/heads/topic"},{...main(),ref:"refs/tags/v1.0.0"},{...main(),eventName:"push"},{...main(),eventName:"pull_request_target"},{...main(),repository:"example/other"},{...main(),sha:"main"}]) assert.throws(()=>target(input));
});
for (const result of ["failure","cancelled","skipped","timed_out","neutral","",undefined]) {
  test(`shipping rejects absent or unsuccessful compatibility: ${result}`,()=>{
    assert.throws(()=>decision("merge-candidate","success",result,sha,sha),/compatibility-not-successful/);
    assert.throws(()=>decision("main-candidate",result,"success",sha,sha),/shipping-preparation-failed/);
  });
}
test("success for another commit, missing output, or unknown mode cannot authorize shipping",()=>{
  assert.equal(decision("merge-candidate","success","success",sha,sha),"verified-candidate");
  assert.equal(decision("main-candidate","success","success",sha,sha),"verified-candidate");
  for (const value of [other,"",undefined]) assert.throws(()=>decision("merge-candidate","success","success",value,sha),/shipping-revision-mismatch/);
  assert.throws(()=>decision("","success","success",sha,sha),/unsupported-shipping-mode/);
});
test("environment gates require independent review without administrator bypass",()=>{
  protectedEnvironment(environment(),policies());
  const mutations=[e=>e.name="other",e=>e.can_admins_bypass=true,e=>delete e.can_admins_bypass,e=>e.protection_rules=[],e=>e.protection_rules[0].prevent_self_review=false,e=>e.protection_rules[0].reviewers=[],e=>e.deployment_branch_policy=null];
  for(const mutate of mutations){const value=environment();mutate(value);assert.throws(()=>protectedEnvironment(value,policies()));}
});
test("environment branches exclude PRs, arbitrary branches, and tags",()=>{
  for(const names of [["*"],["main"],["main","main"],["main","gh-readonly-queue/main/*","topic"],["main","refs/pull/*"]]) assert.throws(()=>protectedEnvironment(environment(),policies(names)));
  const tag=policies();tag.branch_policies[0].type="tag";
  assert.throws(()=>protectedEnvironment(environment(),tag));
  const partial=policies();partial.total_count=3;
  assert.throws(()=>protectedEnvironment(environment(),partial));
  protectedEnvironment(environment("release-publisher"),policies(["main"]),"release-publisher");
  assert.throws(()=>protectedEnvironment(environment("release-publisher"),policies(),"release-publisher"));
});
test("dependencies use complete immutable commits with no extra keys",()=>{
  const pins={version:1,claude:sha,collector:sha,pipeline:sha};
  assert.equal(dependencies(pins),pins);
  for(const change of [{claude:"main"},{collector:"a".repeat(39)},{pipeline:"A".repeat(40)},{version:2},{extra:sha},{pipeline:null}]) assert.throws(()=>dependencies({...pins,...change}));
});
test("publication refuses changed main, wrong checkout, or a retargeted tag",()=>{
  publication(sha,sha,sha,null,new Date().toISOString());publication(sha,sha,sha,sha,new Date().toISOString());
  for(const values of [[sha,other,sha,null],[sha,sha,other,null],[sha,sha,sha,other],["",sha,sha,null]]) assert.throws(()=>publication(...values,new Date().toISOString()));
});
test("ruleset rendering keeps review protections additive and publisher bypass separate",()=>{
  const [mainRules,creation,immutable]=rulesets(123456);
  assert.deepEqual(mainRules.bypass_actors,[]);
  assert.equal(mainRules.rules.find(r=>r.type==="merge_queue").parameters.grouping_strategy,"ALLGREEN");
  const checks=mainRules.rules.find(r=>r.type==="required_status_checks").parameters.required_status_checks;
  assert.ok(checks.some(c=>c.context==="Compatibility required" && c.integration_id===CHECKS_APP));
  assert.deepEqual(creation.rules,[{type:"creation"}]);
  assert.deepEqual(creation.bypass_actors,[{actor_id:123456,actor_type:"Integration",bypass_mode:"always"}]);
  assert.deepEqual(immutable.bypass_actors,[]);
  assert.deepEqual(immutable.rules,[{type:"update"},{type:"deletion"}]);
  for(const value of [undefined,0,-1,NaN,CHECKS_APP,"123",1.5]) assert.throws(()=>rulesets(value));
});
test("CLI binds checkout, remote main and live annotated tags without reading real credentials",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"shipping-policy-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const repo=path.join(root,"repo"),remote=path.join(root,"remote.git");fs.mkdirSync(repo);
  const env={PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:os.devNull};
  const git=(...args)=>execFileSync("git",["-c","user.name=Fixture","-c","user.email=fixture@example.invalid",...args],{cwd:repo,env,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  git("init","--bare",remote);git("init","-b","main");git("remote","add","origin",remote);
  fs.mkdirSync(path.join(repo,"compatibility"));fs.writeFileSync(path.join(repo,"compatibility/dependencies.json"),JSON.stringify({version:1,claude:sha,collector:sha,pipeline:sha}));
  fs.mkdirSync(path.join(repo,"plugins/skillmeter/.codex-plugin"),{recursive:true});fs.writeFileSync(path.join(repo,"plugins/skillmeter/.codex-plugin/plugin.json"),JSON.stringify({version:"1.2.3"}));
  git("add",".");git("commit","-m","fixture");const first=git("rev-parse","HEAD");git("push","origin","main");
  const event=path.join(root,"event.json"),output=path.join(root,"output");fs.writeFileSync(event,JSON.stringify(base().event));
  const cli=(command,overrides={})=>spawnSync(process.execPath,[path.resolve(__dirname,"../../../.github/scripts/shipping-policy.cjs"),command],{cwd:repo,env:{...env,GITHUB_EVENT_NAME:"workflow_dispatch",GITHUB_REF:"refs/heads/main",GITHUB_SHA:first,GITHUB_REPOSITORY:repository,GITHUB_EVENT_PATH:event,GITHUB_OUTPUT:output,VERIFIED_SHA:first,VERIFIED_AT:new Date().toISOString(),...overrides},encoding:"utf8"});
  assert.equal(cli("prepare").status,0);
  assert.match(cli("prepare",{GITHUB_SHA:other}).stderr,/checkout-revision-mismatch/);
  assert.equal(cli("publish").status,0);assert.match(fs.readFileSync(output,"utf8"),/tag=v1.2.3/);
  git("tag","-a","v1.2.3","-m","fixture");git("push","origin","v1.2.3");assert.equal(cli("publish").status,0);
  git("commit","--allow-empty","-m","next");const next=git("rev-parse","HEAD");git("push","origin","main");
  // Remote changes after checkout cannot be hidden by stale local tags or refs.
  git("checkout","--detach",first);assert.match(cli("publish").stderr,/release-candidate-changed/);
  git("checkout","--detach",next);assert.match(cli("publish",{GITHUB_SHA:next,VERIFIED_SHA:next}).stderr,/release-tag-mismatch/);
});

test("publication requires recent successful evidence even after a delayed approval",()=>{
  const now=Date.parse("2026-01-01T12:00:00Z");
  publication(sha,sha,sha,null,"2026-01-01T11:01:00Z",now);
  for(const at of [undefined,"","invalid","2026-01-01T10:59:59Z","2026-01-01T12:00:01Z"]) assert.throws(()=>publication(sha,sha,sha,null,at,now),/release-evidence-expired/);
});

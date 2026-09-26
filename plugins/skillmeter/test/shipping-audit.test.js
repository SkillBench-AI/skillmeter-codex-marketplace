"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {audit,collect}=require("../../../.github/scripts/shipping-audit.cjs");
const {rulesets}=require("../../../.github/scripts/shipping-rules.cjs");
function configured(){
  const environments={};
  for(const name of ["compatibility-reviewed","release-publisher"]){
    const names=name==="release-publisher"?["main"]:["main","gh-readonly-queue/main/*"];
    environments[name]={configuration:{name,can_admins_bypass:false,protection_rules:[{type:"required_reviewers",prevent_self_review:true,reviewers:[{type:"Team",reviewer:{id:1}}]}],deployment_branch_policy:{custom_branch_policies:true,protected_branches:false}},branches:{total_count:names.length,branch_policies:names.map(name=>({name,type:"branch"}))},secretNames:[name==="release-publisher"?"RELEASE_APP_PRIVATE_KEY":"COMPATIBILITY_READ_TOKEN"]};
  }
  return {version:1,repository:{full_name:"example/plugin",default_branch:"main",allow_merge_commit:true},errors:[],rulesets:[...rulesets(4242),{target:"branch",enforcement:"active",conditions:{ref_name:{include:["~DEFAULT_BRANCH"],exclude:[]}},bypass_actors:[],rules:[{type:"pull_request",parameters:{required_approving_review_count:1,dismiss_stale_reviews_on_push:true}},{type:"deletion"},{type:"non_fast_forward"}]}],publisherAppId:4242,environments,repositorySecretNames:[],workflowPermissions:{default_workflow_permissions:"read",can_approve_pull_request_reviews:false}};
}
test("audit admits complete configuration but never certifies hosted enforcement",()=>{
  const result=audit(configured());assert.equal(result.status,"configured");assert.match(result.limits.join(" "),/not hosted enforcement proof/);
});
const mutations={
 "API error":s=>s.errors.push({reason:"unreadable"}),
 "missing error inventory":s=>delete s.errors,
 "wrong main":s=>s.repository.default_branch="other",
 "merge commits disabled":s=>s.repository.allow_merge_commit=false,
 "disabled required rules":s=>s.rulesets[0].enforcement="disabled",
 "evaluate-only rules":s=>s.rulesets[0].enforcement="evaluate",
 "main excluded":s=>s.rulesets[0].conditions.ref_name.exclude=["refs/heads/main"],
 "irrelevant branch":s=>s.rulesets[0].conditions.ref_name.include=["refs/heads/topic"],
 "unknown wildcard":s=>s.rulesets[0].conditions.ref_name.include=["refs/heads/m*"],
 "admin bypass":s=>s.rulesets[0].bypass_actors=[{actor_type:"OrganizationAdmin",bypass_mode:"always"}],
 "hidden bypass inventory":s=>delete s.rulesets[0].bypass_actors,
 "missing required check":s=>s.rulesets[0].rules[0].parameters.required_status_checks.pop(),
 "wrong check App":s=>s.rulesets[0].rules[0].parameters.required_status_checks[0].integration_id=123,
 "unbound check App":s=>delete s.rulesets[0].rules[0].parameters.required_status_checks[0].integration_id,
 "missing queue":s=>s.rulesets[0].rules.pop(),
 "queue only HEADGREEN":s=>s.rulesets[0].rules[1].parameters.grouping_strategy="HEADGREEN",
 "squash queue":s=>s.rulesets[0].rules[1].parameters.merge_method="SQUASH",
 "review removed":s=>s.rulesets[3].rules.shift(),
 "stale review retained":s=>s.rulesets[3].rules[0].parameters.dismiss_stale_reviews_on_push=false,
 "tag creation extra actor":s=>s.rulesets[1].bypass_actors.push({actor_id:7,actor_type:"User",bypass_mode:"always"}),
 "publisher retarget bypass":s=>s.rulesets[2].bypass_actors=[{actor_id:4242,actor_type:"Integration",bypass_mode:"always"}],
 "wrong tag scope":s=>s.rulesets[2].conditions.ref_name.include=["refs/tags/other*"],
 "shared publisher identity":s=>s.publisherAppId=15368,
 "missing environment":s=>delete s.environments["compatibility-reviewed"],
 "self-review allowed":s=>s.environments["compatibility-reviewed"].configuration.protection_rules[0].prevent_self_review=false,
 "environment admin bypass":s=>s.environments["release-publisher"].configuration.can_admins_bypass=true,
 "publisher any branch":s=>s.environments["release-publisher"].branches.branch_policies[0].name="*",
 "publisher tag allowed":s=>s.environments["release-publisher"].branches.branch_policies[0].type="tag",
 "private token absent":s=>s.environments["compatibility-reviewed"].secretNames=[],
 "broad publisher credential":s=>s.repositorySecretNames=["RELEASE_APP_PRIVATE_KEY"],
 "default token write":s=>s.workflowPermissions.default_workflow_permissions="write"
};
for(const [name,mutate] of Object.entries(mutations))test(`audit holds ${name}`,()=>{const s=configured();mutate(s);assert.equal(audit(s).status,"hold");});
test("collector uses GET-shaped endpoint data, paginates and refuses inaccessible details",()=>{
  const calls=[];const get=endpoint=>{
    calls.push(endpoint);
    if(endpoint==="repos/example/plugin")return {full_name:"example/plugin",permissions:{admin:true}};
    if(endpoint.includes("rulesets?") && endpoint.endsWith("page=1"))return Array.from({length:100},(_,i)=>({id:i+1}));
    if(endpoint.includes("rulesets?") && endpoint.endsWith("page=2"))return [{id:101}];
    if(/rulesets\/\d+$/.test(endpoint))return {bypass_actors:[]};
    if(endpoint.includes("/actions/secrets"))return {total_count:0,secrets:[]};
    throw Error("api-not-found");
  };
  const s=collect("example/plugin",get);assert.equal(s.rulesets.length,101);assert.ok(calls.some(c=>c.endsWith("page=2")));
  assert.ok(!s.errors.some(e=>e.endpoint.endsWith("branches/main/protection")));
  assert.equal(audit(s).status,"hold");
  assert.throws(()=>collect("../../unexpected",get),/invalid-repository/);
});
test("missing admin visibility cannot turn classic-protection 404 into verified absence",()=>{
  const s=collect("example/plugin",endpoint=>{if(endpoint==="repos/example/plugin")return {full_name:"example/plugin"};if(endpoint.includes("rulesets?"))return [];throw Error("api-not-found");});
  assert.ok(s.errors.some(e=>e.endpoint.endsWith("branches/main/protection")));
});
test("partial or changing paginated counts and missing bypass arrays fail closed",()=>{
  const s=collect("example/plugin",endpoint=>{
    if(endpoint==="repos/example/plugin")return {full_name:"example/plugin",permissions:{admin:true}};
    if(endpoint.includes("rulesets?"))return [{id:1}];
    if(endpoint.endsWith("rulesets/1"))return {rules:[]};
    if(endpoint.includes("actions/secrets"))return {total_count:2,secrets:[]};
    throw Error("api-read-failed");
  });
  assert.ok(s.errors.some(e=>e.reason==="incomplete-list"));assert.ok(s.errors.some(e=>e.reason==="ruleset-details-or-bypass-unreadable"));assert.equal(audit(s).status,"hold");
});
module.exports={configured};

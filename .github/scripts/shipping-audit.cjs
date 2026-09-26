"use strict";
const fs = require("node:fs");
const {execFileSync} = require("node:child_process");
const {protectedEnvironment} = require("./shipping-policy.cjs");
const {rulesets, REQUIRED_CHECKS, CHECKS_APP} = require("./shipping-rules.cjs");
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const empty = value => Array.isArray(value) && value.length === 0;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
function audit(snapshot) {
  const checks=[];
  const add=(id,ok,action)=>checks.push({id,status:ok?"pass":"hold",...(ok?{}:{action})});
  const repo=snapshot?.repository;
  add("complete-read",snapshot?.version===1 && REPOSITORY.test(repo?.full_name || "") && empty(snapshot.errors),"Resolve API access or response errors and collect a fresh complete snapshot.");
  add("main-distribution",repo?.default_branch==="main" && repo?.allow_merge_commit===true,"Use main as the distribution branch and enable merge commits for the verified queue strategy.");
  const all=Array.isArray(snapshot?.rulesets)?snapshot.rulesets:[];
  const scoped=(rule,target,patterns)=>rule?.enforcement==="active" && rule.target===target && empty(rule.conditions?.ref_name?.exclude) && Array.isArray(rule.conditions?.ref_name?.include) && rule.conditions.ref_name.include.some(p=>patterns.includes(p));
  // Narrow allowlist: unrecognized glob semantics remain a hold, never guessed.
  const main=all.filter(r=>scoped(r,"branch",["refs/heads/main","~DEFAULT_BRANCH","~ALL"]) && empty(r.bypass_actors));
  const rules=main.flatMap(r=>Array.isArray(r.rules)?r.rules:[]);
  const queue=rules.find(r=>r.type==="merge_queue")?.parameters;
  add("merge-queue",queue?.grouping_strategy==="ALLGREEN" && queue.merge_method==="MERGE" && queue.max_entries_to_build===1 && queue.max_entries_to_merge===1 && queue.min_entries_to_merge===1 && Number.isInteger(queue.check_response_timeout_minutes) && queue.check_response_timeout_minutes>0 && queue.check_response_timeout_minutes<=60,"Require the reviewed ALLGREEN single-candidate MERGE queue on main with no bypass and a check deadline at most 60 minutes.");
  const contexts=rules.filter(r=>r.type==="required_status_checks").flatMap(r=>r.parameters?.required_status_checks || []);
  for(const context of REQUIRED_CHECKS) add(`check:${context}`,contexts.some(c=>c.context===context && c.integration_id===CHECKS_APP),`Require '${context}' from GitHub Actions App ${CHECKS_APP} on main in a no-bypass ruleset.`);
  add("independent-pr-review",rules.some(r=>r.type==="pull_request" && Number.isInteger(r.parameters?.required_approving_review_count) && r.parameters.required_approving_review_count>=1 && r.parameters.dismiss_stale_reviews_on_push===true),"Preserve at least one approving PR review, stale-review dismissal and no bypass on main.");
  for(const type of ["deletion","non_fast_forward"]) add(`main:${type}`,rules.some(r=>r.type===type),`Preserve main ${type} protection with no bypass.`);
  let expected;
  try { expected=rulesets(snapshot?.publisherAppId); } catch {}
  add("dedicated-publisher",Boolean(expected),"Configure release-publisher RELEASE_APP_ID with the dedicated publisher App ID, distinct from GitHub Actions.");
  const tags=all.filter(r=>scoped(r,"tag",["refs/tags/v*","~ALL"]));
  add("tag-creation",Boolean(expected) && tags.some(r=>same(r.bypass_actors,expected[1].bypass_actors) && r.rules?.some(x=>x.type==="creation")),"Restrict version-tag creation to only the dedicated publisher App.");
  for(const type of ["update","deletion"]) add(`tag:${type}`,tags.some(r=>empty(r.bypass_actors) && r.rules?.some(x=>x.type===type)),`Prohibit version-tag ${type} with no bypass, including the publisher App.`);
  for(const name of ["compatibility-reviewed","release-publisher"]) {
    const entry=snapshot?.environments?.[name];let valid=false;
    try {protectedEnvironment(entry?.configuration,entry?.branches,name);valid=true;}catch{}
    add(`environment:${name}`,valid,`Configure ${name} with independent reviewers, no admin bypass and exactly the documented branch policies.`);
    const required=name==="compatibility-reviewed"?"COMPATIBILITY_READ_TOKEN":"RELEASE_APP_PRIVATE_KEY";
    add(`secret:${name}`,Array.isArray(entry?.secretNames) && entry.secretNames.includes(required),`Store ${required} in ${name}; secret presence does not prove its permissions or validity.`);
  }
  add("no-repository-credentials",Array.isArray(snapshot?.repositorySecretNames) && !snapshot.repositorySecretNames.some(n=>["COMPATIBILITY_READ_TOKEN","RELEASE_APP_PRIVATE_KEY"].includes(n)),"Remove broad repository copies of the protected compatibility/publisher credentials after establishing environment-only access.");
  add("default-token-read",snapshot?.workflowPermissions?.default_workflow_permissions==="read" && snapshot.workflowPermissions.can_approve_pull_request_reviews===false,"Keep the default workflow token read-only and disable PR approval permission.");
  return {version:1,kind:"shipping-configuration-audit",repository:repo?.full_name || null,observedAt:snapshot?.observedAt || null,status:checks.every(c=>c.status==="pass")?"configured":"hold",checks,readErrors:Array.isArray(snapshot?.errors)?snapshot.errors:[],limits:["Configuration inspection is not hosted enforcement proof.","Does not validate secret contents, App installation scopes, organization secret inheritance, reviewer membership or deployed runtime revisions.","Classic branch protection is collected for review; passing requires the documented no-bypass rulesets."]};
}
function github(endpoint) {
  // Explicit GET only. Never expose raw API errors or credential-bearing stderr.
  try {return JSON.parse(execFileSync("gh",["api","--method","GET",endpoint],{encoding:"utf8",stdio:["ignore","pipe","pipe"],maxBuffer:8*1024*1024}));}
  catch(error){if(/\(HTTP 404\)/.test(String(error.stderr)))throw Error("api-not-found");throw Error("api-read-failed");}
}
function collect(repository,get=github) {
  if(!REPOSITORY.test(repository))throw Error("invalid-repository");
  const root=`repos/${repository}`,errors=[];
  const read=(endpoint,optional404=false)=>{try{return get(endpoint);}catch(error){if(optional404 && error.message==="api-not-found")return null;errors.push({endpoint,reason:error.message==="api-not-found"?"not-found":"unreadable"});return null;}};
  const list=(endpoint,key)=>{
    const rows=[];let count;
    for(let page=1;page<=100;page++){
      const data=read(`${endpoint}${endpoint.includes("?")?"&":"?"}per_page=100&page=${page}`);
      const batch=key?data?.[key]:data;
      if(!Array.isArray(batch) || (key && (!Number.isInteger(data.total_count) || (count!==undefined && count!==data.total_count)))){errors.push({endpoint,reason:"incomplete-list"});return null;}
      if(key)count=data.total_count;
      rows.push(...batch);
      if(batch.length<100){if(key && rows.length!==count){errors.push({endpoint,reason:"incomplete-list"});return null;}return rows;}
    }
    errors.push({endpoint,reason:"pagination-limit"});return null;
  };
  const repositoryData=read(root);
  if(repositoryData?.full_name?.toLowerCase()!==repository.toLowerCase())errors.push({endpoint:root,reason:"repository-mismatch"});
  const summaries=list(`${root}/rulesets?includes_parents=true`);
  const details=(summaries || []).map(r=>Number.isSafeInteger(r.id)?read(`${root}/rulesets/${r.id}`):null);
  if(details.some(r=>!r || !Array.isArray(r.bypass_actors)))errors.push({endpoint:`${root}/rulesets`,reason:"ruleset-details-or-bypass-unreadable"});
  const environments={};let publisherAppId;
  for(const name of ["compatibility-reviewed","release-publisher"]){
    const endpoint=`${root}/environments/${name}`,configuration=read(endpoint);
    if(!configuration){environments[name]=null;continue;}
    const branches=list(`${endpoint}/deployment-branch-policies`,"branch_policies");
    const secrets=list(`${endpoint}/secrets`,"secrets");
    environments[name]={configuration,branches:branches?{total_count:branches.length,branch_policies:branches}:null,secretNames:secrets?.map(s=>s.name) ?? null};
    if(name==="release-publisher"){
      const variable=read(`${endpoint}/variables/RELEASE_APP_ID`);
      if(typeof variable?.value==="string" && /^[1-9]\d*$/.test(variable.value))publisherAppId=Number(variable.value);
    }
  }
  const secrets=list(`${root}/actions/secrets`,"secrets");
  // With verified repository admin visibility, 404 here means no classic rule.
  const classic=read(`${root}/branches/main/protection`,repositoryData?.permissions?.admin===true);
  return {version:1,observedAt:new Date().toISOString(),repository:repositoryData,rulesets:details,environments,publisherAppId,repositorySecretNames:secrets?.map(s=>s.name) ?? null,workflowPermissions:read(`${root}/actions/permissions/workflow`),classicProtection:classic,errors};
}
module.exports={audit,collect,github,REPOSITORY};
if(require.main===module){
  try{
    const [mode,input]=process.argv.slice(2);
    if(!["live","snapshot"].includes(mode) || !input)throw Error("usage");
    const snapshot=mode==="live"?collect(input):JSON.parse(fs.readFileSync(input,"utf8"));
    const result=audit(snapshot);console.log(JSON.stringify(result,null,2));process.exitCode=result.status==="configured"?0:1;
  }catch{console.log(JSON.stringify({version:1,kind:"shipping-configuration-audit",status:"hold",reason:"audit-input-or-api-failed"}));process.exitCode=2;}
}

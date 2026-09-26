"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{spawnSync}=require("node:child_process");
const {prepare,sandbox,baseline,evaluate,observe,TEMPLATE_FILES,expectedHashes}=require("../../../.github/scripts/shipping-rehearsal.cjs");
const {CASES}=require("../../../.github/scripts/rehearsal-fixture.cjs");
const repository="example/test-shipping-rehearsal",sha="a".repeat(40),old="b".repeat(40),now=Date.parse("2026-01-01T12:05:00Z");
function evidence(scenario="good",release=false){
  const hashes=Object.fromEntries(TEMPLATE_FILES.map(f=>[f,"c".repeat(64)]));
  const before={version:1,kind:"shipping-rehearsal-baseline",repository,observedAt:"2026-01-01T12:00:00Z",mainSha:old,releaseVersion:"0.0.1",tagAbsent:true,releaseAbsent:true,sourceHashes:hashes};
  const run={id:123,run_attempt:1,status:"completed",head_sha:sha,created_at:"2026-01-01T12:01:00Z",repository:{full_name:repository},event:release?"workflow_dispatch":"merge_group",path:release?".github/workflows/release.yml":".github/workflows/shipping.yml",head_branch:release?"main":"gh-readonly-queue/main/pr-1",conclusion:scenario==="good"?"success":scenario==="cancelled"?"cancelled":"failure"};
  const fault={failure:"failure",cancelled:"cancelled",timeout:"timed_out"}[scenario] || "success";
  const job=(name,conclusion,steps=[])=>({run_id:123,run_attempt:1,status:"completed",name,conclusion,steps});
  const jobs=[job("compatibility / Synthetic compatibility fixture",fault,[{name:"Emit synthetic result",started_at:"2026-01-01T12:02:00Z",status:"completed",conclusion:fault==="timed_out"?"cancelled":fault}])];
  if(!release)jobs.push(job("Compatibility required",scenario==="good"?"success":"failure",[{name:"Require the result for this candidate",status:"completed",conclusion:scenario==="good"?"success":"failure"}]));
  else jobs.push(job("Publish verified main candidate",scenario==="good"?"success":["failure","cancelled","timeout"].includes(scenario)?"skipped":"failure",[{name:"Recheck exact candidate before publication",conclusion:scenario==="good"?"success":"failure"},{name:"Create repository-scoped publisher token",conclusion:scenario==="good"?"success":"skipped"}]));
  const after={repository,releaseVersion:"0.0.1",mainSha:scenario==="good" && !release?sha:old,scenario,sourceHashes:{...hashes},tagSha:scenario==="good"?sha:null,releasePublished:scenario==="good",tagAbsent:scenario!=="good",releaseAbsent:scenario!=="good"};
  return {before,run,jobs,after,scenario};
}
const result=e=>evaluate(e.before,e.run,e.jobs,e.after,e.scenario,now);
for(const scenario of CASES)for(const release of [false,true]){
  if(scenario==="stale-evidence" && !release)continue;
  test(`observer accepts the expected ${release?"release":"queue"} ${scenario} outcome`,()=>assert.equal(result(evidence(scenario,release)).status,"pass"));
}
const mutations={
 "unrelated workflow":e=>e.run.path=".github/workflows/other.yml",
 "PR instead of merge candidate":e=>e.run.event="pull_request",
 "another repository":e=>e.run.repository.full_name="example/other",
 "baseline taken after run":e=>e.before.observedAt="2026-01-01T12:02:00Z",
 "stale baseline":e=>e.before.observedAt="2025-12-01T00:00:00Z",
 "rerun":e=>e.run.run_attempt=2,
 "pending job":e=>e.jobs[0].status="in_progress",
 "unrelated job set":e=>e.jobs[0].run_id=456,
 "missing fixture":e=>e.jobs.shift(),
 "duplicate fixture":e=>e.jobs.push(e.jobs[0]),
 "setup failure before fault":e=>e.jobs[0].steps=[],
 "wrong fault outcome":e=>e.jobs[0].conclusion="success",
 "bad candidate reached main":e=>e.after.mainSha=sha,
 "scenario changed":e=>e.after.scenario="good",
 "workflow changed since baseline":e=>e.after.sourceHashes[".github/workflows/shipping.yml"]="d".repeat(64),
 "fault masked by another failure":e=>e.jobs[1].conclusion="success"
};
for(const [name,mutate]of Object.entries(mutations))test(`observer rejects ${name}`,()=>{const e=evidence("failure");mutate(e);assert.equal(result(e).status,"hold");});
test("publication guard must reject before minting a publisher token",()=>{
  const e=evidence("changed-candidate",true);e.jobs[1].steps[1].conclusion="success";assert.equal(result(e).status,"hold");
  const other=evidence("failure",true);other.jobs[1].conclusion="failure";assert.equal(result(other).status,"hold");
});
test("negative release side effects and positive metadata mismatches are held",()=>{
  const e=evidence("failure",true);e.after.tagAbsent=false;assert.equal(result(e).status,"hold");
  const good=evidence("good",true);good.after.tagSha=old;assert.equal(result(good).status,"hold");
  assert.equal(result(evidence("stale-evidence",false)).status,"hold");
});
test("bundle generation is exclusive, sandbox-only and binds fixtures to the repository",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"shipping-rehearsal-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,"bundle");prepare(repository,dir);
  assert.throws(()=>prepare(repository,dir));
  for(const value of ["SkillBench-AI/skillmeter-codex-marketplace","SkillBench-AI/skillmeter-claude-code-marketplace","../../bad","example/repo\n"])assert.throws(()=>sandbox(value));
  const release=fs.readFileSync(path.join(dir,".github/workflows/release.yml"),"utf8");
  assert.match(release,/preflight:\n    needs: sandbox/);assert.match(release,/environment: release-publisher/);
  assert.match(release,/permission-contents: write/);
  for(const scenario of ["good","failure","missing-evidence","changed-candidate","stale-evidence"]){
    fs.writeFileSync(path.join(dir,"compatibility/rehearsal-case.json"),JSON.stringify({scenario}));
    const output=path.join(root,scenario);
    const env={PATH:process.env.PATH,GITHUB_REPOSITORY:repository,GITHUB_SHA:sha,GITHUB_OUTPUT:output};
    const run=spawnSync(process.execPath,[".github/scripts/rehearsal-fixture.cjs","emit"],{cwd:dir,env,encoding:"utf8"});
    assert.equal(run.status,scenario==="failure"?1:0);
    if(scenario==="failure")assert.match(run.stderr,/deliberate-compatibility-failure/);
    else{
      const receipt=fs.readFileSync(output,"utf8");
      if(scenario==="good")assert.match(receipt,new RegExp(`verified_sha=${sha}`));
      if(scenario==="missing-evidence")assert.match(receipt,/verified_sha=\n/);
      if(scenario==="changed-candidate")assert.match(receipt,/verified_sha=0{40}/);
      if(scenario==="stale-evidence")assert.match(receipt,/2000-01-01/);
    }
    const wrong=spawnSync(process.execPath,[".github/scripts/rehearsal-fixture.cjs","guard"],{cwd:dir,env:{...env,GITHUB_REPOSITORY:"example/production"},encoding:"utf8"});assert.equal(wrong.status,1);
  }
});
test("observer refuses incomplete job pagination without treating it as no side effects",()=>{
  const e=evidence("failure");e.before.sourceHashes=expectedHashes(repository);
  assert.throws(()=>observe(e.before,123,"failure",endpoint=>endpoint.includes("/attempts/")?{total_count:2,jobs:[e.jobs[0]]}:e.run),/incomplete-job-evidence/);
});

test("observer rejects pre-existing releases and missing successful publisher jobs",()=>{
  const stale=evidence("good",true);stale.before.releaseAbsent=false;assert.equal(result(stale).status,"hold");
  const missing=evidence("good",true);missing.jobs.pop();assert.equal(result(missing).status,"hold");
  const wrong=evidence("good",true);wrong.after.releaseVersion="0.0.2";assert.equal(result(wrong).status,"hold");
});

test("observer does not count a checkout failure as policy rejection",()=>{
  const e=evidence("missing-evidence");e.jobs[1].steps[0].conclusion="skipped";assert.equal(result(e).status,"hold");
});
test("observer refuses a baseline from another workflow template before API access",()=>{
  const e=evidence();let calls=0;
  assert.throws(()=>observe(e.before,123,"good",()=>{calls++;}),/not-the-reviewed-rehearsal-bundle/);assert.equal(calls,0);
});
test("baseline and live observer bind API source bytes to this exact generated bundle",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"rehearsal-api-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,"bundle");prepare(repository,dir);
  const e=evidence("good");
  const get=endpoint=>{
    if(endpoint===`repos/${repository}`)return {full_name:repository,default_branch:"main"};
    if(endpoint.endsWith("/git/ref/heads/main"))return {object:{sha}};
    if(endpoint.includes("/contents/")){const file=endpoint.split("/contents/")[1].split("?")[0];return {encoding:"base64",content:fs.readFileSync(path.join(dir,file)).toString("base64")};}
    if(endpoint.includes("/git/ref/tags/") || endpoint.includes("/releases/tags/"))throw Error("api-not-found");
    if(endpoint.endsWith("/actions/runs/123"))return e.run;
    if(endpoint.includes("/attempts/1/jobs?"))return {total_count:e.jobs.length,jobs:e.jobs};
    throw Error("unexpected-api");
  };
  const before=baseline(repository,get);before.observedAt=new Date(Date.now()-60000).toISOString();e.run.created_at=new Date(Date.now()-30000).toISOString();
  assert.equal(observe(before,123,"good",get).status,"pass");
  fs.appendFileSync(path.join(dir,".github/workflows/shipping.yml"),"# changed before baseline\n");
  assert.throws(()=>baseline(repository,get),/not-the-reviewed-rehearsal-bundle/);
});
test("dispatch scenarios are confined to the generated fixture and validated",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"rehearsal-dispatch-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,"bundle");prepare(repository,dir);
  fs.writeFileSync(path.join(dir,"compatibility/rehearsal-case.json"),JSON.stringify({scenario:"failure"}));
  const env={PATH:process.env.PATH,GITHUB_REPOSITORY:repository,GITHUB_SHA:sha,GITHUB_OUTPUT:path.join(root,"out"),GITHUB_EVENT_NAME:"workflow_dispatch",REHEARSAL_CASE:"good"};
  const run=spawnSync(process.execPath,[".github/scripts/rehearsal-fixture.cjs","emit"],{cwd:dir,env,encoding:"utf8"});assert.equal(run.status,0);
  const missing=spawnSync(process.execPath,[".github/scripts/rehearsal-fixture.cjs","emit"],{cwd:dir,env:{...env,REHEARSAL_CASE:""},encoding:"utf8"});assert.equal(missing.status,1);
  assert.match(fs.readFileSync(path.join(dir,".github/workflows/release.yml"),"utf8"),/run-name: Synthetic release/);
});

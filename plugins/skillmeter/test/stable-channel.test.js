"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { rulesets, inspect, promote, compareVersions } = require("../../../.github/scripts/stable-channel.cjs");
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
function fixture() {
  const repo = "example/plugin", root = `repos/${repo}`, writes = [];
  const env = { GITHUB_REPOSITORY: repo, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main",
    RELEASE_TAG: "v0.11.0", RELEASE_SHA: B, EXPECTED_STABLE: A, RELEASE_RUN_ID: "42", RELEASE_APP_ID: "12345",
    SMOKE_EVIDENCE_URL: `https://github.com/${repo}/pull/1#issuecomment-123` };
  const rules = [...rulesets(12345), { target: "tag", enforcement: "active", bypass_actors: [],
    conditions: {ref_name:{include:["refs/tags/v*"],exclude:[]}},rules:[{type:"update"},{type:"deletion"}] }];
  const data = {
    [`${root}/rulesets?includes_parents=true&per_page=100&page=1`]: rules.map((_,i) => ({id:i+1, source_type:"Repository"})),
    ...Object.fromEntries(rules.map((r,i) => [`${root}/rulesets/${i+1}`,r])),
    [`${root}/environments/release-publisher`]: {can_admins_bypass:false, deployment_branch_policy:{custom_branch_policies:true,protected_branches:false},protection_rules:[{type:"required_reviewers",prevent_self_review:true,reviewers:[{type:"User",reviewer:{id:123}}]}]},
    [`${root}/environments/release-publisher/deployment-branch-policies?per_page=100`]: {total_count:1,branch_policies:[{type:"branch",name:"main"}]},
    [`${root}/git/ref/tags/v0.11.0`]: {object:{type:"tag",sha:C}},
    [`${root}/git/tags/${C}`]: {object:{type:"commit",sha:B}},
    [`${root}/git/ref/heads/main`]: {object:{sha:C}},
    [`${root}/git/ref/heads/stable`]: {object:{sha:A}},
    [`${root}/compare/${B}...${C}`]: {status:"ahead"},
    [`${root}/compare/${A}...${B}`]: {status:"ahead"},
    [`${root}/releases/tags/v0.11.0`]: {tag_name:"v0.11.0",draft:false,prerelease:false,published_at:"2026-01-01T00:00:00Z",assets:[{name:"skillmeter-codex-marketplace-v0.11.0.tar.gz",state:"uploaded",size:10}]},
    [`${root}/actions/runs/42`]: {repository:{full_name:repo},head_repository:{full_name:repo},path:".github/workflows/release.yml",head_sha:B,status:"completed",conclusion:"success",event:"push",head_branch:"v0.11.0"},
    [`${root}/git/matching-refs/heads/stable`]: [{ref:"refs/heads/stable",object:{sha:A}}],
  };
  const manifest = (sha,version) => { data[`${root}/contents/plugins/skillmeter/.codex-plugin/plugin.json?ref=${sha}`] = {encoding:"base64",content:Buffer.from(JSON.stringify({version})).toString("base64")}; };
  manifest(A,"0.10.0"); manifest(B,"0.11.0");
  const api = (path, method="GET", body) => {
    if (method !== "GET") {
      writes.push({path,method,body});
      data[`${root}/git/ref/heads/stable`].object.sha = body.sha;
      return {};
    }
    assert.ok(Object.hasOwn(data,path),`unexpected read: ${path}`);
    return structuredClone(data[path]);
  };
  return {env,data,root,writes,api,manifest};
}
test("promotion uses the released SHA even after main advances; never force pushes", () => {
  const f=fixture(); assert.equal(inspect(f.env,f.api).sha,B); assert.equal(f.writes.length,0);
  assert.equal(promote(f.env,f.api).status,"promoted");
  assert.deepEqual(f.writes,[{path:`${f.root}/git/refs/heads/stable`,method:"PATCH",body:{sha:B,force:false}}]);
});
test("first promotion creates only stable; a similarly named branch is not stable",()=>{
  const f=fixture(); f.env.EXPECTED_STABLE="absent";
  f.data[`${f.root}/git/matching-refs/heads/stable`]=[{ref:"refs/heads/stable-test",object:{sha:A}}];
  promote(f.env,f.api); assert.deepEqual(f.writes,[{path:`${f.root}/git/refs`,method:"POST",body:{ref:"refs/heads/stable",sha:B}}]);
});
test("retry of the same stable commit is read-only",()=>{
  const f=fixture();f.env.EXPECTED_STABLE=B;
  f.data[`${f.root}/git/matching-refs/heads/stable`][0].object.sha=B;
  f.data[`${f.root}/git/ref/heads/stable`].object.sha=B;
  f.data[`${f.root}/compare/${B}...${B}`]={status:"identical"};
  promote(f.env,f.api);assert.equal(f.writes.length,0);
});
const failures = [
  ["non-main dispatch",f=>{f.env.GITHUB_REF="refs/heads/feature"},/dispatch-main/],
  ["pull request invocation",f=>{f.env.GITHUB_EVENT_NAME="pull_request"},/dispatch-main/],
  ["shell-like tag",f=>{f.env.RELEASE_TAG="v0.11.0; echo nope"},/invalid-tag/],
  ["abbreviated SHA",f=>{f.env.RELEASE_SHA="bbbbbbb"},/full-release/],
  ["foreign smoke evidence",f=>{f.env.SMOKE_EVIDENCE_URL="https://example.com/receipt"},/smoke-evidence/],
  ["shared Actions publisher",f=>{f.env.RELEASE_APP_ID="15368"},/dedicated-publisher/],
  ["unprotected stable",f=>{f.data[`${f.root}/rulesets/1`].enforcement="disabled"},/missing-stable-promotion/],
  ["additional bypass",f=>{f.data[`${f.root}/rulesets/1`].bypass_actors.push({actor_type:"RepositoryRole",actor_id:5})},/missing-stable-promotion/],
  ["publisher can force push",f=>{f.data[`${f.root}/rulesets/2`].bypass_actors=f.data[`${f.root}/rulesets/1`].bypass_actors},/missing-stable-integrity/],
  ["mutable release tags",f=>{f.data[`${f.root}/rulesets/3`].rules=[]},/immutable-release-tags/],
  ["self approval",f=>{f.data[`${f.root}/environments/release-publisher`].protection_rules[0].prevent_self_review=false},/protected-publisher/],
  ["admin bypass",f=>{f.data[`${f.root}/environments/release-publisher`].can_admins_bypass=true},/protected-publisher/],
  ["publisher branch wildcard",f=>{f.data[`${f.root}/environments/release-publisher/deployment-branch-policies?per_page=100`].branch_policies[0].name="*"},/publisher-main-only/],
  ["retargeted tag",f=>{f.data[`${f.root}/git/tags/${C}`].object.sha=A},/tag-candidate/],
  ["manifest mismatch",f=>{f.manifest(B,"0.12.0")},/tag-version/],
  ["unmerged candidate",f=>{f.data[`${f.root}/compare/${B}...${C}`].status="diverged"},/candidate-not-on-main/],
  ["draft release",f=>{f.data[`${f.root}/releases/tags/v0.11.0`].draft=true},/published-release/],
  ["prerelease",f=>{f.data[`${f.root}/releases/tags/v0.11.0`].prerelease=true},/published-release/],
  ["missing archive",f=>{f.data[`${f.root}/releases/tags/v0.11.0`].assets=[]},/release-archive/],
  ["failed release job",f=>{f.data[`${f.root}/actions/runs/42`].conclusion="failure"},/successful-release/],
  ["wrong workflow",f=>{f.data[`${f.root}/actions/runs/42`].path=".github/workflows/ci.yml"},/successful-release/],
  ["wrong tested commit",f=>{f.data[`${f.root}/actions/runs/42`].head_sha=A},/successful-release/],
  ["fork run",f=>{f.data[`${f.root}/actions/runs/42`].head_repository.full_name="fork/plugin"},/successful-release/],
  ["superseded stable",f=>{f.data[`${f.root}/git/matching-refs/heads/stable`][0].object.sha=C},/stable-changed/],
  ["version downgrade",f=>{f.manifest(A,"0.12.0")},/version-must-increase/],
  ["same-version code replacement",f=>{f.manifest(A,"0.11.0")},/version-must-increase/],
  ["non-fast-forward promotion",f=>{f.data[`${f.root}/compare/${A}...${B}`].status="diverged"},/stable-fast-forward/],
];
for (const [name,modify,error] of failures) test(`holds without writes: ${name}`,()=>{
  const f=fixture();modify(f);assert.throws(()=>promote(f.env,f.api),error);assert.equal(f.writes.length,0);
});
test("metadata access failure cannot look like absent stable",()=>{
  const f=fixture();assert.throws(()=>promote(f.env,()=>{throw Error("access-denied")}),/access-denied/);assert.equal(f.writes.length,0);
});
test("failed server-side update is surfaced without retry or fallback",()=>{
  const f=fixture();assert.throws(()=>promote(f.env,(p,m,b)=>{if(m)throw Error("non-fast-forward");return f.api(p,m,b)}),/non-fast-forward/);assert.equal(f.writes.length,0);
});
test("unexpected post-write stable ref is reported as failure",()=>{
  const f=fixture();
  assert.throws(()=>promote(f.env,(p,m,b)=>{
    const result=f.api(p,m,b);
    if(p===`${f.root}/git/ref/heads/stable`) result.object.sha=C;
    return result;
  }),/promotion-not-observed/);
});
test("published lightweight release tags are supported",()=>{
  const f=fixture();f.data[`${f.root}/git/ref/tags/v0.11.0`].object={type:"commit",sha:B};
  assert.equal(inspect(f.env,f.api).sha,B);
});
test("new release workflow dispatch contract is accepted",()=>{
  const f=fixture();Object.assign(f.data[`${f.root}/actions/runs/42`],{event:"workflow_dispatch",head_branch:"main"});
  assert.equal(inspect(f.env,f.api).sha,B);
});
test("version order is numeric including large components",()=>{
  assert.equal(compareVersions("0.11.0","0.9.9"),1);
  assert.equal(compareVersions("0.9007199254740993.0","0.9007199254740992.0"),1);
  assert.throws(()=>compareVersions("0.11.0-rc1","0.10.0"),/invalid-version/);
});

// Opt-in host integration: uses only a temporary home and a synthetic Git repo.
// CODEX_MARKETPLACE_SMOKE=1 node --test plugins/skillmeter/test/stable-channel.test.js
// No real credentials, hooks or telemetry are copied into this fixture.
test("installed Codex keeps stable isolated and updates only after promotion", {skip: process.env.CODEX_MARKETPLACE_SMOKE !== "1", timeout:90000}, () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"stable-marketplace-"));
  try {
    const home=path.join(temp,"home"), cwd=path.join(temp,"workspace"), repo=path.join(temp,"repo"), remote=path.join(temp,"remote.git");
    for (const dir of [home,cwd,repo]) fs.mkdirSync(dir,{recursive:true});
    const env={PATH:process.env.PATH,HOME:home,CODEX_HOME:path.join(home,".codex"),XDG_CONFIG_HOME:path.join(home,".config"),GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:path.join(temp,"gitconfig"),GIT_TERMINAL_PROMPT:"0"};
    fs.mkdirSync(env.CODEX_HOME,{recursive:true});
    const run=(command,args,where=cwd)=>execFileSync(command,args,{cwd:where,env,encoding:"utf8",timeout:20000,stdio:["ignore","pipe","pipe"]});
    const git=(...args)=>run("git",args,repo);
    run("git",["init","--bare",remote]);git("init","-b","main");git("config","user.name","Synthetic test");git("config","user.email","test@example.invalid");
    git("remote","add","origin",remote);
    run("git",["config","--file",env.GIT_CONFIG_GLOBAL,`url.file://${remote}.insteadOf`,"https://example.invalid/stable-marketplace.git"]);
    const plugin=path.join(repo,"plugins/skillmeter");
    fs.mkdirSync(path.join(repo,".agents/plugins"),{recursive:true});fs.mkdirSync(path.join(plugin,".codex-plugin"),{recursive:true});
    fs.mkdirSync(path.join(plugin,"skills/synthetic"),{recursive:true});
    fs.writeFileSync(path.join(plugin,"skills/synthetic/SKILL.md"),"---\nname: synthetic\ndescription: Synthetic stable channel fixture\n---\nReply synthetic.\n");
    fs.writeFileSync(path.join(repo,".agents/plugins/marketplace.json"),JSON.stringify({name:"stable-fixture",interface:{displayName:"Synthetic fixture"},plugins:[{name:"skillmeter",source:{source:"local",path:"./plugins/skillmeter"},policy:{installation:"AVAILABLE",authentication:"ON_INSTALL"},category:"Productivity"}]}));
    const commit=version=>{fs.writeFileSync(path.join(plugin,".codex-plugin/plugin.json"),JSON.stringify({name:"skillmeter",version,description:"Synthetic stable fixture"}));git("add",".");git("commit","-m",version);return git("rev-parse","HEAD").trim()};
    const initial=commit("0.10.0");git("branch","stable");git("push","origin","main","stable");
    const codex=(...args)=>run("codex",args);
    const add=ref=>JSON.parse(codex("plugin","marketplace","add","https://example.invalid/stable-marketplace.git","--ref",ref,"--json"));
    const install=()=>JSON.parse(codex("plugin","add","skillmeter@stable-fixture","--json"));
    const versions=()=>{
      const dir=path.join(env.CODEX_HOME,"plugins/cache/stable-fixture/skillmeter");
      const output=[];
      function scan(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=path.join(p,e.name);if(e.isDirectory())scan(f);else if(e.name==="plugin.json")output.push(JSON.parse(fs.readFileSync(f,"utf8")).version)}}
      scan(dir);return output;
    };
    add("main");install();assert.ok(versions().includes("0.10.0"));
    assert.throws(()=>add("stable"),/different source/);
    codex("plugin","marketplace","remove","stable-fixture","--json");
    add("stable");install();
    const list=codex("plugin","marketplace","list","--json");
    const marketplaces=JSON.parse(list).marketplaces.filter(m=>m.name==="stable-fixture");
    assert.equal(marketplaces.length,1,"duplicate marketplace registration");
    assert.equal(run("git",["rev-parse","HEAD"],marketplaces[0].root).trim(),initial);
    const next=commit("0.11.0");git("push","origin","main");
    codex("plugin","marketplace","upgrade","stable-fixture","--json");install();
    assert.ok(!versions().includes("0.11.0"),"unreleased main leaked into stable install");
    git("push","origin",`${next}:refs/heads/stable`);
    codex("plugin","marketplace","upgrade","stable-fixture","--json");install();
    assert.ok(versions().includes("0.11.0"),"promoted version not installed");
    assert.notEqual(initial,next);
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
});

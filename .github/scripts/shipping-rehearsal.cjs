"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const TEMPLATE_FILES=["shipping.yml","release.yml","compatibility.yml","ci.yml"].map(n=>`.github/workflows/${n}`).concat(["shipping-policy.cjs","shipping-rules.cjs","compatibility-contract.cjs","rehearsal-fixture.cjs"].map(n=>`.github/scripts/${n}`),["compatibility/contract.json","compatibility/dependencies.json","compatibility/rehearsal.json","package.json"]);
function sourceHashes(root,sha,get){
  return Object.fromEntries(TEMPLATE_FILES.map(file=>{const response=get(`${root}/contents/${file}?ref=${sha}`);if(response.encoding!=="base64" || typeof response.content!=="string")throw Error("source-unreadable");return [file,crypto.createHash("sha256").update(Buffer.from(response.content,"base64")).digest("hex")];}));
}
const {github,REPOSITORY}=require("./shipping-audit.cjs");
const {revision}=require("./compatibility-contract.cjs");
const {CASES}=require("./rehearsal-fixture.cjs");
const SOURCE=path.resolve(__dirname,"../..");
const CHECKOUT="actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
const NODE="actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
function sandbox(repository) {
  if(!REPOSITORY.test(repository) || !repository.endsWith("-shipping-rehearsal"))throw Error("dedicated-rehearsal-repository-required");
  return repository;
}
function bundle(repository) {
  sandbox(repository);
  const files={};
  const write=(name,content)=>{files[name]=Buffer.from(content);};
  for(const file of ["shipping-policy.cjs","shipping-rules.cjs","compatibility-contract.cjs","rehearsal-fixture.cjs"])write(`.github/scripts/${file}`,fs.readFileSync(path.join(SOURCE,".github/scripts",file)));
  for(const file of ["contract.json","dependencies.json"])write(`compatibility/${file}`,fs.readFileSync(path.join(SOURCE,"compatibility",file)));
  write("compatibility/rehearsal.json",JSON.stringify({version:1,repository,syntheticOnly:true},null,2)+"\n");
  write("compatibility/rehearsal-case.json",JSON.stringify({scenario:"good"},null,2)+"\n");
  write("plugins/skillmeter/.codex-plugin/plugin.json",JSON.stringify({version:"0.0.1"})+"\n");
  write("package.json",JSON.stringify({private:true,scripts:{"check:compatibility":"node .github/scripts/compatibility-contract.cjs"}},null,2)+"\n");
  const steps=`      - uses: ${CHECKOUT}\n        with:\n          ref: \${{ github.sha }}\n          persist-credentials: false\n      - uses: ${NODE}\n        with:\n          node-version: 22\n`;
  const guard=`  sandbox:\n    env:\n      REHEARSAL_CASE: \${{ github.event.inputs.scenario }}\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n${steps}      - run: node .github/scripts/rehearsal-fixture.cjs guard\n`;
  for(const name of ["shipping","release"]){
    let workflow=fs.readFileSync(path.join(SOURCE,`.github/workflows/${name}.yml`),"utf8");
    const anchor=name==="shipping"?"  prepare:\n":"  preflight:\n";
    if(workflow.split(anchor).length!==2 || workflow.split("jobs:\n").length!==2)throw Error("workflow-template-changed");
    workflow=workflow.replace("jobs:\n",`jobs:\n${guard}`).replace(anchor,`${anchor}    needs: sandbox\n`);
    if(name==="release")workflow=workflow.replace("name: Release\n","name: Release\nrun-name: Synthetic release (\${{ inputs.scenario }})\n").replace("  workflow_dispatch:\n","  workflow_dispatch:\n    inputs:\n      scenario:\n        type: choice\n        required: true\n        default: good\n        options: [good, failure, missing-evidence, changed-candidate, stale-evidence, cancelled, timeout]\n");
    write(`.github/workflows/${name}.yml`,workflow);
  }
  write(".github/workflows/compatibility.yml",`name: Synthetic compatibility fixture
on:
  workflow_call:
    outputs:
      verified_sha:
        value: \${{ jobs.fixture.outputs.verified_sha }}
      verified_at:
        value: \${{ jobs.fixture.outputs.verified_at }}
permissions:
  contents: read
jobs:
  fixture:
    name: Synthetic compatibility fixture
    env:
      REHEARSAL_CASE: \${{ github.event.inputs.scenario }}
    environment: compatibility-reviewed
    runs-on: ubuntu-latest
    timeout-minutes: 1
    outputs:
      verified_sha: \${{ steps.emit.outputs.verified_sha }}
      verified_at: \${{ steps.emit.outputs.verified_at }}
    steps:
${steps}      - name: Validate synthetic context
        run: node .github/scripts/rehearsal-fixture.cjs guard
      - id: emit
        name: Emit synthetic result
        run: node .github/scripts/rehearsal-fixture.cjs emit
`);
  write(".github/workflows/ci.yml",`name: Synthetic required checks
on: [pull_request, merge_group]
permissions:
  contents: read
jobs:
  checks:
    name: \${{ matrix.check }}
    runs-on: ubuntu-latest
    strategy:
      matrix:
        check: ['Test (Node 20)', 'Test (Node 22)', 'Test candidate contract runner', 'Validate manifests & version']
    steps:
${steps}      - run: node .github/scripts/rehearsal-fixture.cjs guard
`);
  write("README.md",`# Disposable shipping rehearsal\n\nTarget: ${repository}. Synthetic data only. This repository is not a marketplace.\n\nThe shipping and release workflows are copied from the source with an added target guard.\nPrivate compatibility is replaced with explicit synthetic results. Do not use any production\npublisher identity or private-read credential. Configure independent reviewers and a dedicated\nsandbox publisher App before enabling the queue or running a release. Never publish this\nbundle over an existing repository. See the source compatibility/REHEARSAL.md for cases.\n`);
  return files;
}
function expectedHashes(repository){const files=bundle(repository);return Object.fromEntries(TEMPLATE_FILES.map(file=>[file,crypto.createHash("sha256").update(files[file]).digest("hex")]));}
function matchingSource(repository,hashes){const expected=expectedHashes(repository);return TEMPLATE_FILES.every(file=>hashes?.[file]===expected[file]);}
function prepare(repository,directory){
  const files=bundle(repository);
  // Exclusive creation prevents overwriting any checkout, including production.
  fs.mkdirSync(directory,{mode:0o700});
  for(const [name,content] of Object.entries(files)){const file=path.join(directory,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content,{flag:"wx"});}
  return {version:1,kind:"shipping-rehearsal-bundle",repository,syntheticOnly:true,cases:CASES};
}
function optional(get,endpoint){try{return get(endpoint);}catch(error){if(error.message==="api-not-found")return null;throw error;}}
function baseline(repository,get=github) {
  sandbox(repository);
  const root=`repos/${repository}`,repo=get(root);
  if(repo.full_name!==repository || repo.default_branch!=="main")throw Error("rehearsal-repository-mismatch");
  const head=get(`${root}/git/ref/heads/main`).object?.sha;
  if(!revision(head))throw Error("invalid-main-revision");
  const marker=get(`${root}/contents/compatibility/rehearsal.json?ref=${head}`);
  const parsed=JSON.parse(Buffer.from(marker.content,"base64").toString());
  if(parsed.repository!==repository || parsed.syntheticOnly!==true)throw Error("missing-rehearsal-marker");
  const manifest=get(`${root}/contents/plugins/skillmeter/.codex-plugin/plugin.json?ref=${head}`);
  const version=JSON.parse(Buffer.from(manifest.content,"base64").toString()).version;
  if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))throw Error("invalid-fixture-version");
  const hashes=sourceHashes(root,head,get);
  if(!matchingSource(repository,hashes))throw Error("not-the-reviewed-rehearsal-bundle");
  return {version:1,kind:"shipping-rehearsal-baseline",repository,observedAt:new Date().toISOString(),mainSha:head,releaseVersion:version,tagAbsent:optional(get,`${root}/git/ref/tags/v${version}`)===null,releaseAbsent:optional(get,`${root}/releases/tags/v${version}`)===null,sourceHashes:hashes};
}
function evaluate(before,run,jobs,after,scenario,now=Date.now()) {
  const reasons=[];const check=(ok,reason)=>{if(!ok)reasons.push(reason);};
  check(before?.version===1 && before.kind==="shipping-rehearsal-baseline" && revision(before.mainSha),"invalid-baseline");
  check(CASES.includes(scenario),"unknown-scenario");
  check(TEMPLATE_FILES.every(file=>/^[a-f0-9]{64}$/.test(before?.sourceHashes?.[file]) && before.sourceHashes[file]===after?.sourceHashes?.[file]),"rehearsal-source-changed");
  check(run?.repository?.full_name===before.repository && after?.repository===before.repository,"repository-mismatch");
  const start=Date.parse(run?.created_at),bound=Date.parse(before?.observedAt);
  check(Number.isFinite(start) && Number.isFinite(bound) && bound<=start && start<=now && now-bound<=86400000,"stale-or-late-baseline");
  check(run?.run_attempt===1 && run.status==="completed" && revision(run.head_sha),"incomplete-or-retried-run");
  check(Array.isArray(jobs) && jobs.length>0 && jobs.every(j=>j.run_id===run.id && j.run_attempt===1 && j.status==="completed"),"incomplete-job-evidence");
  const release=run?.event==="workflow_dispatch" && run.path===".github/workflows/release.yml" && run.head_branch==="main";
  const merge=run?.event==="merge_group" && run.path===".github/workflows/shipping.yml" && run.head_branch?.startsWith("gh-readonly-queue/main/");
  check(release || merge,"wrong-workflow-or-event");
  if(release)check(before.tagAbsent===true && before.releaseAbsent===true && before.releaseVersion===after.releaseVersion,"release-baseline-not-fresh");
  check(after?.scenario===scenario,"scenario-not-bound-to-run-commit");
  const all=Array.isArray(jobs)?jobs:[];
  const fixture=all.filter(j=>j.name.endsWith("Synthetic compatibility fixture"));
  check(fixture.length===1,"missing-or-duplicate-fixture-job");
  const fixtureConclusion=fixture[0]?.conclusion;
  const expected={good:"success",failure:"failure","missing-evidence":"success","changed-candidate":"success","stale-evidence":"success",cancelled:"cancelled",timeout:"timed_out"}[scenario];
  check(fixtureConclusion===expected,"wrong-fault-outcome");
  const emission=fixture[0]?.steps?.find(s=>s.name==="Emit synthetic result");
  check(Boolean(emission?.started_at) && emission.status==="completed" && emission.conclusion===(["cancelled","timeout"].includes(scenario)?"cancelled":expected),"fixture-did-not-exercise-fault");
  const required=all.filter(j=>j.name==="Compatibility required");
  const decision=required[0]?.steps?.find(s=>s.name==="Require the result for this candidate");
  const publisher=all.filter(j=>j.name==="Publish verified main candidate");
  if(scenario==="good"){
    check(run.conclusion==="success","good-run-failed");
    if(merge){check(after?.mainSha===run.head_sha,"combined-candidate-not-merged");check(required.length===1 && required[0].conclusion==="success" && decision?.conclusion==="success" && decision.status==="completed","required-check-did-not-pass");}
    else {check(after?.tagSha===run.head_sha && after?.releasePublished===true,"verified-release-not-published");check(publisher.length===1 && publisher[0].conclusion==="success","publisher-did-not-succeed");}
  }else{
    // Stale evidence is a publication fault only; main queue acceptance has no
    // delayed publisher approval, so this case must use release dispatch.
    if(scenario==="stale-evidence")check(release,"stale-case-requires-release");
    check(["failure","cancelled","timed_out"].includes(run.conclusion),"bad-run-not-rejected");
    check(after?.mainSha===before.mainSha,"main-changed-during-negative-case");
    if(release)check(after?.tagAbsent===true && after?.releaseAbsent===true,"negative-release-side-effect");
    if(merge && !["cancelled","timeout"].includes(scenario))check(required.length===1 && required[0].conclusion==="failure" && decision?.conclusion==="failure" && decision.status==="completed","required-check-did-not-reject");
    if(release){
      if(["failure","cancelled","timeout"].includes(scenario))check(publisher.every(j=>["skipped","cancelled"].includes(j.conclusion) && !j.steps?.some(s=>s.name==="Create repository-scoped publisher token" && s.conclusion!=="skipped")),"publisher-ran-after-compatibility-failure");
      else check(publisher.length===1 && publisher[0].conclusion==="failure" && publisher[0].steps?.some(s=>s.name==="Recheck exact candidate before publication" && s.conclusion==="failure") && publisher[0].steps?.some(s=>s.name==="Create repository-scoped publisher token" && s.conclusion==="skipped"),"publication-policy-did-not-reject");
    }
  }
  return {version:1,kind:"shipping-rehearsal-observation",repository:before.repository,scenario,runId:run.id,candidate:run.head_sha,status:reasons.length?"hold":"pass",reasons,scope:"synthetic-hosted-orchestration-only",limits:["Does not certify real private compatibility or production configuration.","Successful release metadata is checked; archive bytes, queue removal and tag-write denial tests require separate acceptance."]};
}
function observe(before,runId,scenario,get=github) {
  sandbox(before.repository);
  if(!matchingSource(before.repository,before.sourceHashes))throw Error("not-the-reviewed-rehearsal-bundle");
  if(!/^\d+$/.test(String(runId)))throw Error("invalid-run-id");
  const root=`repos/${before.repository}`,run=get(`${root}/actions/runs/${runId}`);
  if(!revision(run.head_sha))throw Error("invalid-run-revision");
  const jobs=[];let total;
  for(let page=1;page<=100;page++){
    const response=get(`${root}/actions/runs/${runId}/attempts/1/jobs?per_page=100&page=${page}`);
    if(!Array.isArray(response.jobs) || !Number.isInteger(response.total_count) || (total!==undefined && total!==response.total_count))throw Error("incomplete-job-evidence");
    total=response.total_count;jobs.push(...response.jobs);
    if(response.jobs.length<100)break;
  }
  if(jobs.length!==total)throw Error("incomplete-job-evidence");
  const content=file=>JSON.parse(Buffer.from(get(`${root}/contents/${file}?ref=${run.head_sha}`).content,"base64").toString());
  const marker=content("compatibility/rehearsal.json");
  if(marker.repository!==before.repository || marker.syntheticOnly!==true)throw Error("missing-rehearsal-marker");
  const after={repository:before.repository,mainSha:get(`${root}/git/ref/heads/main`).object?.sha,scenario:content("compatibility/rehearsal-case.json").scenario,sourceHashes:sourceHashes(root,run.head_sha,get)};
  if(run.event==="workflow_dispatch"){
    after.scenario=/^Synthetic release \(([a-z-]+)\)$/.exec(run.display_title || "")?.[1];
    const version=content("plugins/skillmeter/.codex-plugin/plugin.json").version;
    if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))throw Error("invalid-fixture-version");
    after.releaseVersion=version;
    const tag=optional(get,`${root}/git/ref/tags/v${version}`),release=optional(get,`${root}/releases/tags/v${version}`);
    after.tagAbsent=tag===null;after.releaseAbsent=release===null;
    after.tagSha=tag?.object?.type==="commit"?tag.object.sha:null;
    after.releasePublished=release?.draft===false && release.prerelease===false && release.tag_name===`v${version}` && release.assets?.some(a=>a.name===`skillmeter-codex-marketplace-v${version}.tar.gz` && a.state==="uploaded" && a.size>0);
  }
  return evaluate(before,run,jobs,after,scenario);
}
module.exports={sandbox,prepare,baseline,evaluate,observe,TEMPLATE_FILES,expectedHashes};
if(require.main===module){
  try{
    const [command,a,b,c]=process.argv.slice(2);
    let result;
    if(command==="prepare")result=prepare(a,b);
    else if(command==="baseline")result=baseline(a);
    else if(command==="observe")result=observe(JSON.parse(fs.readFileSync(a,"utf8")),b,c);
    else throw Error("unknown-command");
    console.log(JSON.stringify(result,null,2));if(result.status==="hold")process.exitCode=1;
  }catch(error){console.log(JSON.stringify({version:1,status:"hold",reason:/^[a-z-]+$/.test(error.message)?error.message:"rehearsal-failed"}));process.exitCode=2;}
}

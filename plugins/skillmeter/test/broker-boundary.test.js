"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const cp = require("node:child_process");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "broker-boundary-"));
const originalHomedir = os.homedir;
os.homedir = () => root;
process.env.PLUGIN_DATA = path.join(root, "data");
delete process.env.SKILLMETER_ACTIVATE_URL;
const state = path.join(root, ".skillbench/credentials.json");
fs.mkdirSync(path.dirname(state), { recursive: true });
const jwt = claims => "e30." + Buffer.from(JSON.stringify({sub:"tenant", exp:1, aud:"https://fixture.meter.skillbench.ai", ...claims})).toString("base64url") + ".fixture";
let shellCalls = 0;
const originalExec = cp.execSync;
cp.execSync = () => { shellCalls++; throw Error("fixture-shell-denied"); };
const store = require("../scripts/credstore");
const logger = require("../scripts/logger");
const activation = require("../scripts/lib/license-activation");
cp.execSync = originalExec;
const originalFetch = global.fetch;
function seed(claims, extra = {}) {
  fs.writeFileSync(state, JSON.stringify({ device_id:"fixture-device", hash_salt:"fixture-salt", license_jwt:jwt(claims), allowed_github_orgs:["old-org", "shared-org"], orgs_explicitly_set:true, future_field:{keep:true}, ...extra }));
  store.refreshFromDisk(); logger.clearLicenseRejected(); shellCalls = 0;
  return fs.readFileSync(state);
}
after(() => { global.fetch = originalFetch; os.homedir = originalHomedir; fs.rmSync(root,{recursive:true,force:true}); });
for (const failure of [401,402,404,410,429,500,"network","invalid-json","missing-token"]) {
  test(`broker refresh ${failure} preserves credentials and never invokes GitHub`, async () => {
    const before = seed({broker_sub:"person", orgs:["shared-org"]});
    let requests = 0;
    global.fetch = async url => {
      requests++; assert.match(url, /\/refresh$/);
      if (failure === "network") throw Error("fixture-offline");
      if (failure === "invalid-json") return {ok:true,json:async()=>{throw Error("fixture-json");}};
      if (failure === "missing-token") return {ok:true,json:async()=>({})};
      return {ok:false,status:failure,text:async()=>"fixture-rejected"};
    };
    assert.equal(await logger.tryRefreshLicense("fixture-device"), null);
    assert.equal(requests, 1); assert.equal(shellCalls, 0);
    assert.deepEqual(fs.readFileSync(state), before);
  });
}
test("direct silent activation cannot replace a broker credential", async () => {
  const before = seed({broker_sub:"person"});
  global.fetch = async () => { assert.fail("activation must not send"); };
  assert.equal(await activation.trySilentGhActivate("fixture-device"), null);
  assert.equal(shellCalls, 0); assert.deepEqual(fs.readFileSync(state), before);
});
test("malformed broker marker still prevents identity fallback", async () => {
  for (const broker_sub of [null, "", 0]) {
    seed({broker_sub});
    assert.equal(await activation.trySilentGhActivate("fixture-device"), null);
    assert.equal(shellCalls, 0);
  }
});
test("broker refresh success retains identity fields, preferences and scope", async () => {
  seed({broker_sub:"person",orgs:["shared-org"]}, {telemetry_disabled:true});
  const before = JSON.parse(fs.readFileSync(state));
  const fresh = jwt({broker_sub:"person",orgs:["shared-org"],exp:4102444800});
  global.fetch = async () => ({ok:true,json:async()=>({token:fresh})});
  assert.equal(await logger.tryRefreshLicense("fixture-device"), fresh);
  assert.deepEqual(JSON.parse(fs.readFileSync(state)), {...before,license_jwt:fresh});
  assert.equal(shellCalls, 0);
});
for (const [name, claims, expected] of [
  ["plural organizations", {orgs:[" SHARED-ORG ","new-org"]}, ["shared-org"]],
  ["explicit empty overrides singular", {orgs:[],org:{login:"shared-org"}}, []],
  ["malformed plural holds", {orgs:null,org:{login:"shared-org"}}, []],
  ["tenant slug is not repository scope", {org:{login:"SHARED-ORG"}}, []],
  ["missing licensed organizations", {}, []],
]) test(`broker scope: ${name}`, () => {
  const before = seed({broker_sub:"person",...claims});
  assert.deepEqual(store.getAllowedGitHubOrgs(), expected);
  assert.deepEqual(fs.readFileSync(state), before, "scope evaluation must not rewrite consent");
});
test("fresh broker sign-in does not invent a stored scope", () => {
  seed({broker_sub:"person",orgs:["new-org"]}, {allowed_github_orgs:undefined,orgs_explicitly_set:undefined});
  assert.deepEqual(store.getAllowedGitHubOrgs(), []);
  assert.equal(store.hasExplicitOrgScope(), false);
});
test("legacy GitHub scope remains unchanged", () => {
  seed({github_id:123,orgs:[]});
  assert.deepEqual(store.getAllowedGitHubOrgs(), ["old-org","shared-org"]);
});

for (const orgs of [[], undefined, ["other-org"]]) test(`broker scope hold preserves queued bytes (${JSON.stringify(orgs)})`, async () => {
  const repo = fs.mkdtempSync(path.join(root, "repo-"));
  fs.mkdirSync(path.join(repo, ".git"));
  fs.writeFileSync(path.join(repo, ".git/config"), '[remote "origin"]\nurl = https://github.com/shared-org/repo.git\n');
  const source = path.join(repo,"source.jsonl");
  seed({broker_sub:"person",orgs:["shared-org"],exp:4102444800});
  logger.saveTelemetryOptIn(repo,true);
  fs.writeFileSync(source,""); logger.observeTranscriptConsent(source,repo);
  fs.appendFileSync(source, JSON.stringify({type:"response_item",payload:{type:"message",role:"user",content:"synthetic authorized text"}})+"\n");
  const chunk = logger.stageTranscriptForUpload(source,{cwd:repo});
  assert.ok(chunk);
  const before = fs.readFileSync(chunk);
  seed({broker_sub:"person",orgs,org:{login:"shared-org"},exp:4102444800});
  global.fetch = async () => assert.fail("scope-held queue must not upload");
  assert.equal(await logger.processPendingTranscript(chunk,"fixture-device"),"skip");
  assert.deepEqual(fs.readFileSync(chunk),before);
  assert.equal(logger.stageTranscriptForUpload(source,{cwd:repo}),null);
});

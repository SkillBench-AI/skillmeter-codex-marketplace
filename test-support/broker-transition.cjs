"use strict";
// Runs only in a child with an allowlisted environment and synthetic credentials.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const [root, claudeRoot, candidateRoot, scenario] = process.argv.slice(2);
os.homedir = () => root;
process.env.PLUGIN_DATA = path.join(root, "data");
process.env.CLAUDE_PLUGIN_DATA = path.join(root, "claude-data");
process.env.SKILLMETER_STATE_DIR = path.join(root, ".skillbench");
let shellCalls = 0;
const cp = require("node:child_process");
for (const key of ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync"]) cp[key] = () => { shellCalls++; throw Error("fixture-process-denied"); };
for (const name of ["node:http", "node:https", "node:net", "node:tls"]) {
  const mod = require(name);
  for (const key of ["request", "get", "connect", "createConnection"]) if (mod[key]) mod[key] = () => { throw Error("fixture-network-denied"); };
}
global.fetch = () => { throw Error("fixture-network-denied"); };
const state = path.join(root, ".skillbench/credentials.json");
fs.mkdirSync(path.dirname(state), {recursive:true});
fs.writeFileSync(state, JSON.stringify({device_id:"fixture-device",hash_salt:"fixture-salt",future_field:{keep:true}}));
const claude = require(path.join(claudeRoot,"scripts/credstore"));
const codex = require(path.join(candidateRoot,"scripts/credstore"));
const jwt = claims => "e30." + Buffer.from(JSON.stringify({sub:"fixture-tenant",broker_sub:"fixture-person",aud:["fixture-resource","https://fixture.meter.skillbench.ai"],exp:1,orgs:["shared-org","new-org"],...claims})).toString("base64url") + ".fixture";
// Only previous Codex sign-in creates this list; Claude must not receive fake orgs.
if (scenario !== "broker-fresh-signin-held") codex.commitSignin({jwt:jwt({github_id:123,broker_sub:undefined}),orgs:["old-org","shared-org"]});
assert.equal(claude.commitSignin({jwt:jwt({})}), true);
const logger = require(path.join(candidateRoot,"scripts/logger"));
const before = fs.readFileSync(state);
(async () => {
  if (scenario === "broker-refresh-failure") {
    for (const status of [401,402,404,410,429,500]) {
      let requests = 0;
      global.fetch = async (url, options) => {
        requests++; assert.match(url, /\/refresh$/);
        assert.equal(options.headers.Authorization, "Bearer " + claude.getLicenseTokenUncached());
        return {ok:false,status,text:async()=>"fixture-rejected"};
      };
      assert.equal(await logger.tryRefreshLicense("fixture-device"), null);
      assert.equal(requests,1); assert.equal(shellCalls,0);
      assert.deepEqual(fs.readFileSync(state),before);
    }
  } else if (scenario === "broker-refresh-success") {
    const fresh = jwt({exp:4102444800,orgs:["new-org"]});
    global.fetch = async () => ({ok:true,json:async()=>({token:fresh})});
    assert.equal(await logger.tryRefreshLicense("fixture-device"),fresh);
    assert.equal(claude.getLicenseTokenUncached(),fresh);
    assert.deepEqual(JSON.parse(fs.readFileSync(state)), {...JSON.parse(before),license_jwt:fresh});
    assert.deepEqual(codex.getAllowedGitHubOrgs(),[],"refresh cannot retain an unlicensed old organization");
    assert.equal(shellCalls,0);
  } else if (scenario === "broker-scope-boundary") {
    codex.refreshFromDisk();
    assert.deepEqual(codex.getAllowedGitHubOrgs(),["shared-org"]);
    assert.deepEqual(fs.readFileSync(state),before,"intersection must not change user choices");
    assert.equal(claude.commitSignin({jwt:jwt({orgs:[],org:{login:"shared-org"}})}),true);
    codex.refreshFromDisk();
    assert.deepEqual(codex.getAllowedGitHubOrgs(),[],"empty plural claim overrides singular fallback");
  } else if (scenario === "broker-fresh-signin-held") {
    codex.refreshFromDisk();
    assert.deepEqual(codex.getAllowedGitHubOrgs(),[]);
    assert.equal(codex.hasExplicitOrgScope(),false);
    assert.deepEqual(fs.readFileSync(state),before);
  } else throw Error("unknown-broker-scenario");
})().catch(error => {console.error(error);process.exitCode=1;});

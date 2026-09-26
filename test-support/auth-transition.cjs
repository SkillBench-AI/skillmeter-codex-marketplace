"use strict";
// Child-only sandbox: no host home, credentials, shell, daemon or network.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const [root, previousRoot, candidateRoot, scenario, client] = process.argv.slice(2);
os.homedir = () => root;
process.env.PLUGIN_DATA = path.join(root, "data");
process.env.CLAUDE_PLUGIN_DATA = path.join(root, "claude-data");
process.env.SKILLMETER_STATE_DIR = path.join(root, ".skillbench");
for (const key of ["SKILLMETER_BACKEND_URL", "SKILLMETER_REPO_SCOPE_ORGS", "SKILLMETER_GITHUB_ORGS"]) delete process.env[key];
const cp = require("node:child_process");
for (const key of ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync"]) cp[key] = () => { throw Error("fixture-process-denied"); };
for (const name of ["node:http", "node:https", "node:net", "node:tls"]) {
  const mod = require(name);
  for (const key of ["request", "get", "connect", "createConnection"]) if (mod[key]) mod[key] = () => { throw Error("fixture-network-denied"); };
}
global.fetch = () => { throw Error("fixture-network-denied"); };
const state = path.join(root, ".skillbench/credentials.json");
fs.mkdirSync(path.dirname(state), { recursive: true });
fs.writeFileSync(state, JSON.stringify({ device_id: "fixture-device", hash_salt: "fixture-salt", future_field: { keep: true } }));
const old = require(path.join(previousRoot, "scripts/credstore"));
const current = require(path.join(candidateRoot, "scripts/credstore"));
const jwt = exp => "e30." + Buffer.from(JSON.stringify({ sub: "fixture-tenant", broker_sub: "fixture-user", exp, aud: "https://fixture.invalid", org: {login:"fixture"} })).toString("base64url") + ".fixture";
const token = jwt(4102444800), fresh = jwt(4102444900);
if (client === "claude") { current.markEngaged(); current.commitSignin({jwt:token, orgs:["fixture"]}); }
old.markEngaged(); assert.equal(old.commitSignin({ jwt: token, orgs: ["fixture"] }), true);
if (client === "claude") {
  const policy = require(path.join(previousRoot,"scripts/lib/telemetry-store"));
  policy.setOrganizationConsent("fixture", true);
  policy.setRepositoryOverride("github.com/fixture/repo", true);
}
const repo = path.join(root, "repo");
fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
fs.writeFileSync(path.join(repo, ".git/config"), '[remote "origin"]\nurl = https://github.com/fixture/repo.git\n');
process.chdir(repo);
const logger = require(path.join(candidateRoot, "scripts/logger"));
logger.saveTelemetryOptIn(repo, true);
logger.logInfo("Stop", "fixture-session", { cwd: logger.hashHmac(repo, "fixture-salt"), repo_root: logger.hashHmac(repo, "fixture-salt") }, "fixture-device");
const batch = logger.sealEventLog(); assert.ok(batch);
const before = fs.readFileSync(batch);
let calls = 0;
global.fetch = async (_url, options) => { calls++; assert.equal(options.headers.Authorization, "Bearer " + current.getLicenseTokenUncached()); return { ok: true, status: 200 }; };
(async () => {
  const snapshot = current.recoverySnapshot();
  if (scenario === "signed-out") old.signOut();
  if (scenario === "expired") old.setLicenseToken(jwt(1));
  if (scenario === "global-pause") client === "claude" ? require(path.join(previousRoot, "scripts/lib/telemetry-store")).setGlobalEnabled(false) : old.setTelemetryDisabled(true);
  if (scenario === "scope-withdrawn") old.commitSignin({ jwt: token, orgs: [] });
  if (scenario === "repository-off") {
    if (client === "claude") {
      require(path.join(previousRoot,"scripts/lib/telemetry-store")).setRepositoryOverride("github.com/fixture/repo", false);
      await logger.drainPendingTranscripts("https://fixture.invalid",1000);
      await logger.processSealedBatch(batch, undefined, 1000);
    } else logger.saveTelemetryOptIn(repo, false);
  }
  if (scenario === "interrupted-refresh") {
    old.signOut();
    assert.equal(current.commitRefresh(fresh, snapshot), false);
    assert.equal(current.getSignedOut(), true);
  }
  if (scenario === "signout-signin-refresh") {
    old.signOut(); old.markEngaged(); old.commitSignin({ jwt: token, orgs: ["fixture"] });
    assert.equal(current.commitRefresh(fresh, snapshot), false, "a prior authentication exchange cannot cross a sign-out/sign-in cycle");
    assert.equal(current.getLicenseTokenUncached(), token);
    assert.deepEqual(fs.readFileSync(batch), before);
    assert.equal(calls, 0);
    return;
  }
  if (scenario === "auth-rejection") global.fetch = async () => { calls++; return { ok: false, status: 401 }; };
  if (scenario === "repository-off") {
    assert.equal(calls, 0, "revoked work must never be sent");
    assert.equal(fs.existsSync(batch + ".sent"), false);
    assert.equal(fs.existsSync(batch), false, "explicit OFF purges this scope");
    logger.saveTelemetryOptIn(repo, true);
    assert.equal(fs.existsSync(batch), false, "re-enable cannot restore revoked data");
  } else {
    const outcome = await logger.processSealedBatch(batch, undefined, 1000);
    if (scenario === "signed-in") { assert.equal(outcome, "sent"); assert.equal(calls, 1); }
    else {
      assert.equal(calls, scenario === "auth-rejection" ? 1 : 0);
      assert.deepEqual(fs.readFileSync(batch), before, "held work remains byte-identical");
      assert.equal(logger.readBatchMeta(batch).attempts, 0);
      if (["signed-out", "interrupted-refresh"].includes(scenario)) assert.equal(current.getLicenseTokenUncached(), null);
      else if (scenario !== "expired") assert.equal(current.getLicenseTokenUncached(), token);
      old.markEngaged(); old.commitSignin({ jwt: fresh, orgs: ["fixture"] });
      if (client === "claude" && scenario === "global-pause") {
        assert.equal(await logger.processSealedBatch(batch, undefined, 1000), "skip", "sign-in must not clear a shared pause");
        require(path.join(previousRoot,"scripts/lib/telemetry-store")).setGlobalEnabled(true);
      }
      global.fetch = async () => { calls++; return {ok:true,status:200}; };
      assert.equal(await logger.processSealedBatch(batch, undefined, 1000), "sent");
      assert.equal(calls, scenario === "auth-rejection" ? 2 : 1);
    }
  }
  const final = JSON.parse(fs.readFileSync(state));
  assert.equal(final.device_id, "fixture-device"); assert.equal(final.hash_salt, "fixture-salt");
  assert.deepEqual(final.future_field, {keep:true});
})().catch(error => { console.error(error); process.exitCode = 1; });

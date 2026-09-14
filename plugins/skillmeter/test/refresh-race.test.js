"use strict";

const { test, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const { once } = require("node:events");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sk-refresh-race-"));
const originalHomedir = os.homedir;
os.homedir = () => root;
process.env.PLUGIN_DATA = path.join(root, "data");
delete process.env.SKILLMETER_ACTIVATE_URL;
const credentialPath = path.join(root, ".skillbench", "credentials.json");
fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
const makeJwt = (sub, exp = Math.floor(Date.now() / 1000) + 3600) =>
  [{ alg: "none" }, { sub, exp, aud: `https://${sub}.meter.skillbench.ai` }]
    .map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".") + ".sig";
const tokenA = makeJwt("tenant-a", 1);
const tokenB = makeJwt("tenant-b");
const refreshedA = makeJwt("tenant-a");
const baseline = { device_id: "TEST-DEVICE", hash_salt: "test", license_jwt: tokenA };
fs.writeFileSync(credentialPath, JSON.stringify(baseline));

// Never invoke the user's gh CLI, including on an unexpected fallback.
const originalExecSync = childProcess.execSync;
let activationAttempts = 0;
childProcess.execSync = () => { activationAttempts++; throw new Error("gh disabled in test"); };
const credstore = require("../scripts/credstore");
const logger = require("../scripts/logger");
const activation = require("../scripts/lib/license-activation");
childProcess.execSync = originalExecSync;
const { acquireLock } = require("../scripts/lib/credential-lock");
const originalFetch = global.fetch;

function readStore() { return JSON.parse(fs.readFileSync(credentialPath, "utf8")); }
function writeStore(value) { fs.writeFileSync(credentialPath, JSON.stringify(value)); }
function otherProcess(code) {
  childProcess.execFileSync(process.execPath, ["-e", `
    require("os").homedir = () => ${JSON.stringify(root)};
    const store = require(${JSON.stringify(require.resolve("../scripts/credstore"))});
    ${code}
  `]);
}

beforeEach(() => {
  writeStore(baseline);
  credstore.setLicenseToken(tokenA); // Warm the cache with A.
  logger.clearLicenseRejected();
  activationAttempts = 0;
});
afterEach(() => { global.fetch = originalFetch; logger.clearLicenseRejected(); });
after(() => { os.homedir = originalHomedir; fs.rmSync(root, { recursive: true, force: true }); });

test("refresh uses disk token after another process replaces the warm cache", async () => {
  otherProcess(`store.setLicenseToken(${JSON.stringify(tokenB)});`);
  assert.equal(credstore.getLicenseToken(), tokenA);
  logger.markLicenseRejected(401);
  let authorization;
  global.fetch = async (_url, options) => {
    authorization = options.headers.Authorization;
    return { ok: true, json: async () => ({ token: tokenB }) };
  };
  assert.equal(await logger.tryRefreshLicense("TEST-DEVICE"), tokenB);
  assert.equal(authorization, `Bearer ${tokenB}`);
  assert.equal(readStore().license_jwt, tokenB);
});

test("signed-out disk state takes precedence over a fresh cached token", async () => {
  credstore.setLicenseToken(tokenB);
  otherProcess("store.signOut();");
  global.fetch = async () => { assert.fail("signed-out refresh must not send"); };
  assert.equal(await logger.tryRefreshLicense("TEST-DEVICE"), null);
  assert.equal(activationAttempts, 0);
});

for (const action of ["signin", "signout", "remove", "rotate", "same-token-signin"]) {
  test(`in-flight refresh cannot overwrite ${action} or activate afterwards`, async () => {
    global.fetch = async () => {
      if (action === "signin") otherProcess(`store.commitSignin({jwt:${JSON.stringify(tokenB)},orgs:["b"]});`);
      if (action === "signout") otherProcess("store.signOut();");
      // Model a legacy writer that does not participate in the new lock.
      if (action === "remove") { const state = readStore(); delete state.license_jwt; writeStore(state); }
      if (action === "rotate") otherProcess(`store.setLicenseToken(${JSON.stringify(tokenB)});`);
      if (action === "same-token-signin") otherProcess(`
        store.signOut(); store.markEngaged();
        store.commitSignin({jwt:${JSON.stringify(tokenA)},orgs:["a"]});
      `);
      return { ok: true, json: async () => ({ token: refreshedA }) };
    };
    assert.equal(await logger.tryRefreshLicense("TEST-DEVICE"), null);
    assert.equal(activationAttempts, 0);
    assert.notEqual(readStore().license_jwt, refreshedA);
    if (action === "signout") assert.equal(readStore().signed_out, true);
    if (action === "signin" || action === "rotate") assert.equal(readStore().license_jwt, tokenB);
    if (action === "same-token-signin") assert.equal(readStore().license_jwt, tokenA);
  });
}

test("failed refresh also skips activation if the account changed", async () => {
  global.fetch = async () => {
    otherProcess(`store.setLicenseToken(${JSON.stringify(tokenB)});`);
    return { ok: false, status: 401, text: async () => "rejected" };
  };
  assert.equal(await logger.tryRefreshLicense("TEST-DEVICE"), null);
  assert.equal(activationAttempts, 0);
  assert.equal(readStore().license_jwt, tokenB);
});

test("unchanged failed refresh retains the existing activation fallback", async () => {
  global.fetch = async () => ({ ok: false, status: 401, text: async () => "rejected" });
  assert.equal(await logger.tryRefreshLicense("TEST-DEVICE"), null);
  assert.equal(activationAttempts, 1);
});

test("only the first of two overlapping refresh responses may commit", async () => {
  const pending = [];
  global.fetch = () => new Promise(resolve => pending.push(resolve));
  const first = logger.tryRefreshLicense("TEST-DEVICE");
  const second = logger.tryRefreshLicense("TEST-DEVICE");
  assert.equal(pending.length, 2);
  pending[1]({ ok: true, json: async () => ({ token: tokenB }) });
  assert.equal(await second, tokenB);
  pending[0]({ ok: true, json: async () => ({ token: refreshedA }) });
  assert.equal(await first, null);
  assert.equal(readStore().license_jwt, tokenB);
  assert.equal(activationAttempts, 0);
});

test("successful refresh preserves current organization and unrelated fields", async () => {
  writeStore({ ...readStore(), allowed_github_orgs: ["a"], custom_field: "preserve" });
  global.fetch = async () => ({ ok: true, json: async () => ({ token: refreshedA }) });
  assert.equal(await activation.refreshExpiredJwt(tokenA, "TEST-DEVICE"), refreshedA);
  assert.equal(readStore().custom_field, "preserve");
  assert.deepEqual(readStore().allowed_github_orgs, ["a"]);
});

test("conditional activation commit cannot overwrite a newer signin", () => {
  const expected = credstore.recoverySnapshot();
  otherProcess(`store.commitSignin({jwt:${JSON.stringify(tokenB)},orgs:["b"]});`);
  assert.equal(credstore.commitSignin({ jwt: refreshedA, orgs: ["a"], expected }), false);
  assert.equal(readStore().license_jwt, tokenB);
  assert.deepEqual(readStore().allowed_github_orgs, ["b"]);
});

test("writers read current state after waiting for the shared lock", async () => {
  const release = acquireLock(`${credentialPath}.lock`);
  const child = childProcess.spawn(process.execPath, ["-e", `
    require("os").homedir = () => ${JSON.stringify(root)};
    const store = require(${JSON.stringify(require.resolve("../scripts/credstore"))});
    process.send("ready");
    store.setTelemetryDisabled(true);
    process.disconnect();
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exited = once(child, "exit");
  try {
    await once(child, "message");
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(readStore().telemetry_disabled, undefined);
    writeStore({ ...readStore(), license_jwt: tokenB });
  } finally { release(); }
  const [code] = await exited;
  assert.equal(code, 0);
  assert.equal(readStore().license_jwt, tokenB);
  assert.equal(readStore().telemetry_disabled, true);
});

// A pid does not identify a process incarnation: after a crash inside the
// critical section the OS can hand that number to an unrelated long-lived
// process. Without the age backstop the lock would then look held for as long
// as that process runs, and every credential write would fail permanently.
test("a stale lock naming a live unrelated process is still reaped", () => {
  const lock = `${credentialPath}.lock.pid-reuse`;
  // process.pid is unquestionably alive and has nothing to do with this lock.
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const old = Date.now() - 120_000;
  fs.utimesSync(lock, old / 1000, old / 1000);

  const release = acquireLock(lock);
  assert.equal(typeof release, "function", "the stale owner was reaped");
  release();
  assert.equal(fs.existsSync(lock), false);
});

test("an unparseable owner file is reaped once stale instead of wedging forever", () => {
  const lock = `${credentialPath}.lock.garbage`;
  fs.writeFileSync(lock, "not json");
  const old = Date.now() - 120_000;
  fs.utimesSync(lock, old / 1000, old / 1000);

  const release = acquireLock(lock);
  assert.equal(typeof release, "function");
  release();
});

test("a fresh lock naming a live process is still respected", () => {
  const lock = `${credentialPath}.lock.fresh`;
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));

  assert.equal(acquireLock(lock), null, "a live owner is never evicted early");
  fs.unlinkSync(lock);
});

test("a crashed writer's lock can be recovered without evicting a live owner", () => {
  const lock = `${credentialPath}.lock`;
  childProcess.execFileSync(process.execPath, ["-e", `
    require(${JSON.stringify(require.resolve("../scripts/lib/credential-lock"))})
      .acquireLock(${JSON.stringify(lock)});
  `]);
  const release = acquireLock(lock);
  assert.equal(typeof release, "function");
  try { assert.equal(acquireLock(lock), null); }
  finally { release(); }
  assert.equal(fs.existsSync(lock), false);
});

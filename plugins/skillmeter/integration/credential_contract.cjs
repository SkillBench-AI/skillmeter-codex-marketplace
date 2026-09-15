"use strict";

// Shared review probes for #37 and #38. These intentionally report unresolved
// contract gaps and are not part of either branch's passing regression suite.
// Run only against trusted checkouts. Every probe gets a fresh synthetic home.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

const cases = [
  "device-change-rejects-old-refresh",
  "identity-change-requires-signin",
  "generation-change-rejects-old-refresh",
  "logout-rejects-old-refresh",
  "every-credential-writer-respects-lock",
];

function probe(checkout, name, home) {
  os.homedir = () => home;
  process.env.HOME = home;
  process.env.SKILLMETER_STATE_DIR = path.join(home, ".skillbench");
  process.env.PLUGIN_DATA = path.join(home, "plugin-data");
  // No network or platform credential migration is needed by these probes.
  require("node:net").Socket.prototype.connect = () => { throw Error("network-disabled"); };
  global.fetch = async () => { throw Error("network-disabled"); };
  require("node:child_process").execSync = () => { throw Error("keychain-and-gh-disabled"); };
  const scripts = path.join(checkout, "plugins/skillmeter/scripts");
  const file = path.join(home, ".skillbench/credentials.json");
  const jwt = (github_id = 123, exp = 1) => "e30." + Buffer.from(JSON.stringify({
    github_id, exp, sub: "synthetic-account", org: {login: "synthetic"},
    aud: "https://synthetic.meter.skillbench.ai",
  })).toString("base64url") + ".synthetic";
  const initial = {device_id: "SYNTHETIC", hash_salt: "synthetic", license_jwt: jwt(), auth_generation: "generation-1"};
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  const write = value => fs.writeFileSync(file, JSON.stringify(value));
  if (name !== "writer-child") write(initial);
  const store = require(path.join(scripts, "credstore"));
  if (name === "writer-child") {
    try { store.setLicenseToken(jwt(123, 2000000000)); return false; }
    catch (error) { return error.message === "credential-store-busy"; }
  }
  const expected = store.recoverySnapshot();
  // The entry points have different names but the same conditional-commit role.
  const commit = store.commitRecovery || store.commitRefresh;
  if (typeof commit !== "function") throw Error("missing-conditional-commit");
  const fresh = jwt(123, 2000000000);
  if (name === "device-change-rejects-old-refresh") {
    write({...read(), device_id: "REPLACEMENT"});
    return commit(fresh, expected) === false && read().license_jwt === initial.license_jwt;
  }
  if (name === "identity-change-requires-signin") {
    return commit(jwt(456, 2000000000), expected) === false && read().license_jwt === initial.license_jwt;
  }
  if (name === "generation-change-rejects-old-refresh") {
    write({...read(), auth_generation: "generation-2"});
    return commit(fresh, expected) === false && read().license_jwt === initial.license_jwt;
  }
  if (name === "logout-rejects-old-refresh") {
    store.signOut();
    return commit(fresh, expected) === false && read().signed_out === true && !read().license_jwt;
  }
  if (name === "every-credential-writer-respects-lock") {
    const lockModule = fs.existsSync(path.join(scripts, "lib/credential-lock.js"))
      ? "lib/credential-lock" : "lib/transcript-delta";
    const release = require(path.join(scripts, lockModule)).acquireLock(file + ".lock");
    if (!release) throw Error("cannot-acquire-test-lock");
    try {
      const child = spawnSync(process.execPath, [__filename, "--probe", checkout, "writer-child", home], {
        env: {HOME: home, PATH: process.env.PATH}, encoding: "utf8", timeout: 5000,
      });
      return child.status === 0 && read().license_jwt === initial.license_jwt;
    } finally { release(); }
  }
  throw Error("unknown-probe");
}

if (process.argv[2] === "--probe") {
  try { process.exit(probe(process.argv[3], process.argv[4], process.argv[5]) ? 0 : 1); }
  catch { process.exit(2); }
} else {
  const checkout = process.argv[2] && path.resolve(process.argv[2]);
  if (!checkout) { console.error("Usage: node credential_contract.cjs TRUSTED_CHECKOUT"); process.exit(2); }
  const revision = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {encoding: "utf8"}).trim();
  const results = cases.map(name => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillbench-contract-"));
    try {
      const run = spawnSync(process.execPath, [__filename, "--probe", checkout, name, home], {
        env: {HOME: home, PATH: process.env.PATH}, encoding: "utf8", timeout: 10000,
      });
      return {name, outcome: run.status === 0 ? "pass" : run.status === 1 ? "gap" : "error"};
    } finally { fs.rmSync(home, {recursive: true, force: true}); }
  });
  console.log(JSON.stringify({schemaVersion: 1, revision, synthetic: true, results}, null, 2));
  process.exit(results.every(r => r.outcome === "pass") ? 0 : 1);
}

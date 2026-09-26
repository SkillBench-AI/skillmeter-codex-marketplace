"use strict";
// Loaded only by the compatibility harness, before any runtime module.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const [root, plugin, client] = process.argv.slice(2);
os.homedir = () => root;
process.env.SKILLMETER_STATE_DIR = path.join(root, ".skillbench");
process.env.CLAUDE_PLUGIN_DATA = path.join(root, "claude-data");
process.env.PLUGIN_DATA = path.join(root, "codex-data");
for (const name of ["http", "https", "net", "tls"]) {
  const module = require(name);
  for (const method of ["request", "get", "connect", "createConnection"]) {
    if (module[method]) module[method] = () => { throw Error("network-forbidden"); };
  }
}
const subprocess = require("node:child_process");
for (const method of ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"]) {
  subprocess[method] = () => { throw Error("subprocess-forbidden"); };
}
const store = require(path.join(plugin, "scripts/credstore.js"));
const activation = require(path.join(plugin, "scripts/lib/license-activation.js"));
const file = path.join(root, ".skillbench/credentials.json");
const originalLink = fs.linkSync;
fs.linkSync = (...args) => {
  try { return originalLink(...args); }
  catch (err) {
    if (err.code === "EEXIST" && args[1] === `${file}.lock`) process.send({ event: "contended" });
    throw err;
  }
};
let resolveResponse, release;
global.fetch = async () => {
  process.send({ event: "request" });
  const response = await new Promise(resolve => { resolveResponse = resolve; });
  if (response.error) throw Error("synthetic-network-failure");
  return { status: response.status, ok: response.status === 200,
    json: async () => ({ token: response.token }), text: async () => "synthetic" };
};
function pauseAt(event) {
  process.send({ event });
  const resume = path.join(root, `resume-${event}-${process.pid}`);
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(resume)) {
    if (Date.now() >= deadline) throw Error("barrier-timeout");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  fs.unlinkSync(resume);
}

process.on("message", async ({ id, op, token, status, error }) => {
  try {
    let value;
    if (op === "response") { resolveResponse({ token, status, error }); return; }
    if (op === "identity") value = [store.getDeviceId(), store.getOrCreateHashSalt()];
    else if (op === "lock") {
      release = require(path.join(plugin, "scripts/lib/credential-lock.js")).acquireLock(`${file}.lock`);
      if (!release) throw Error("lock-not-acquired");
      value = true;
    } else if (op === "unlock") { release(); value = true; }
    else if (op === "pause-before-rename") {
      const rename = fs.renameSync;
      fs.renameSync = (source, target) => {
        if (target !== file) return rename(source, target);
        // The real writer has fsynced and closed its temp file. Stop here until
        // the controller resumes or kills us; the original remains intact.
        fs.renameSync = rename;
        pauseAt("write-ready");
        return rename(source, target);
      };
      store.setLicenseToken(token);
    }
    else if (["pause-before-release", "pause-before-reap"].includes(op)) {
      if (op === "pause-before-release") {
        release = require(path.join(plugin, "scripts/lib/credential-lock.js")).acquireLock(`${file}.lock`);
        if (!release) throw Error("lock-not-acquired");
      }
      const unlink = fs.unlinkSync;
      fs.unlinkSync = target => {
        if (target !== `${file}.lock`) return unlink(target);
        fs.unlinkSync = unlink;
        pauseAt("unlink-ready");
        return unlink(target);
      };
      if (op === "pause-before-release") release();
      else store.setLicenseToken(token);
    }
    else if (op === "set-token") value = store.setLicenseToken(token);
    else if (op === "cycle") {
      store.signOut(); store.markEngaged();
      value = store.commitSignin({ jwt: token, orgs: ["fixture"] });
    } else if (op === "signout") value = store.signOut();
    else if (op === "refresh") {
      const device = store.getDeviceId();
      value = client === "claude" ? await activation.ensureFreshLicense(device) :
        await activation.refreshExpiredJwt(store.getLicenseTokenUncached(), device);
    } else if (op === "read") value = store.getLicenseTokenUncached();
    else throw Error("unknown-operation");
    process.send({ id, value });
  } catch (err) { process.send({ id, error: err.message }); }
});
process.send({ event: "ready" });

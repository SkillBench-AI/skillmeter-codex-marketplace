"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");
const [root, claude, codex, scenario] = process.argv.slice(2);
const file = path.join(root, ".skillbench/credentials.json");
const token = exp => `e30.${Buffer.from(JSON.stringify({ exp, org: { login: "fixture" } })).toString("base64url")}.fixture`;
const expired = token(1), fresh = token(4102444800);
fs.mkdirSync(path.dirname(file), { recursive: true });
const seed = { device_id: "fixture-device", hash_salt: "fixture-salt", license_jwt: expired,
  auth_generation: "fixture-generation", future_field: { preserved: true } };
fs.writeFileSync(file, JSON.stringify(seed));
// Queues and consent are not inputs to this auth exchange and must stay intact.
const queue = path.join(root, "pending-batch.jsonl"), policy = path.join(root, ".skillbench/telemetry-policy.json");
fs.writeFileSync(queue, '{"fixture":"pending"}\n');
fs.writeFileSync(policy, '{"fixture":"consent-must-not-change"}\n');
const preserved = [queue, policy].map(file => fs.readFileSync(file));
const children = [];
function worker(plugin, client) {
  const child = fork(path.join(__dirname, "auth-process-worker.cjs"), [root, plugin, client], {
    env: { PATH: process.env.PATH, TMPDIR: os.tmpdir() }, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const messages = [], waiters = [];
  let counter = 0, exited = false;
  child.on("message", message => {
    messages.push(message);
    for (const wake of [...waiters]) wake();
  });
  child.on("exit", () => { exited = true; for (const wake of [...waiters]) wake(); });
  function take(match) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(Error("worker-timeout")), 5000);
      function finish(error, message) {
        clearTimeout(timer);
        const index = waiters.indexOf(check);
        if (index !== -1) waiters.splice(index, 1);
        error ? reject(error) : resolve(message);
      }
      function check() {
        const index = messages.findIndex(match);
        if (index !== -1) {
          const message = messages.splice(index, 1)[0];
          return finish(message.error ? Error(message.error) : null, message);
        }
        if (exited) finish(Error("worker-exited"));
      }
      waiters.push(check); check();
    });
  }
  const api = { child, event: event => take(m => m.event === event),
    send: (op, args = {}) => {
      const id = ++counter;
      const pending = take(m => m.id === id);
      child.send({ id, op, ...args });
      return pending.then(m => m.value);
    },
    response: args => child.send({ op: "response", ...args }),
    stop: () => new Promise(resolve => {
      if (exited) return resolve();
      child.once("exit", resolve); child.kill("SIGKILL");
    }),
  };
  children.push(api);
  return api;
}
async function main() {
  const a = worker(claude, "claude"), b = worker(codex, "codex");
  await Promise.all([a.event("ready"), b.event("ready")]);
  if (scenario === "concurrent-identity") {
    fs.writeFileSync(file, JSON.stringify({ future_field: seed.future_field }));
    await a.send("lock");
    const second = b.send("identity");
    await b.event("contended");
    await a.send("unlock");
    const [first, other] = await Promise.all([a.send("identity"), second]);
    assert.deepEqual(first, other);
    assert.ok(first.every(Boolean));
  } else if (scenario === "concurrent-writers") {
    // Both lock directions matter: one-sided coordination is insufficient.
    for (const [owner, writer] of [[a, b], [b, a]]) {
      await owner.send("lock");
      const before = fs.readFileSync(file);
      const pending = writer.send("set-token", { token: fresh });
      await writer.event("contended");
      assert.deepEqual(fs.readFileSync(file), before);
      await owner.send("unlock");
      await pending;
      assert.equal(JSON.parse(fs.readFileSync(file)).license_jwt, fresh);
    }
  } else if (scenario === "interrupted-credential-writer") {
    const before = fs.readFileSync(file);
    const interrupted = a.send("pause-before-rename", { token: fresh }).catch(error => error.message);
    await a.event("write-ready");
    const temps = fs.readdirSync(path.dirname(file)).filter(name => name.startsWith("credentials.json.tmp."));
    assert.equal(temps.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(file), temps[0]))).license_jwt, fresh);
    await a.stop();
    assert.equal(await interrupted, "worker-exited");
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(await b.send("read"), expired);
    await b.send("set-token", { token: fresh });
    assert.equal(JSON.parse(fs.readFileSync(file)).license_jwt, fresh);
  } else {
    const refresh = ["delayed-codex-refresh-cycle", "surviving-codex-process"].includes(scenario) ? b : a;
    const actor = refresh === a ? b : a;
    const pending = refresh.send("refresh");
    await refresh.event("request");
    const signedOut = scenario === "delayed-claude-refresh-signout";
    if (signedOut) await actor.send("signout");
    else await actor.send("cycle", { token: expired });
    const before = fs.readFileSync(file);
    const rejected = scenario === "delayed-claude-rejection-cycle";
    refresh.response({ status: rejected ? 402 : 200, token: fresh });
    const returned = await pending;
    assert.equal(returned, refresh === b || signedOut ? null : expired);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(await refresh.send("read"), signedOut ? null : expired);
    // A rejected prior exchange must not write terminal/backoff state.
    assert.equal(fs.existsSync(path.join(root, ".skillbench/license-status.json")), false);
  }
  const final = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(final.future_field, seed.future_field);
  if (scenario !== "concurrent-identity") {
    assert.equal(final.device_id, seed.device_id);
    assert.equal(final.hash_salt, seed.hash_salt);
  }
  [queue, policy].forEach((file, i) => assert.deepEqual(fs.readFileSync(file), preserved[i]));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(async () => { await Promise.all(children.map(child => child.stop())); });

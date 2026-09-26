"use strict";
// Cooperative test interception, not an OS security sandbox.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const base = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(base, "config.json")));
const active = () => Number.isFinite(cfg.expiresAt) && Date.now() < cfg.expiresAt && !fs.existsSync(path.join(base, "disabled"));
if (!active()) process.exit(0);
const block = () => { throw Error("Canary network/process call blocked"); };
for (const name of ["http", "https"]) {
  const m = require(name); m.request = m.get = block;
}
const net = require("node:net"); net.connect = net.createConnection = net.Socket.prototype.connect = block;
require("node:tls").connect = block;
require("node:dgram").createSocket = block;
const cp = require("node:child_process"), spawn = cp.spawn;
for (const name of ["exec", "execSync", "execFile", "execFileSync", "spawnSync", "fork"]) cp[name] = block;
cp.spawn = (command, args, options) => {
  if (!active()) return block();
  if (command === process.execPath && (args?.length === 1 || (args?.length === 2 && args[1] === "--requested")) && args[0] === path.join(base, "codex/scripts/drain_once.js"))
    return spawn(command, args, { ...options, env: process.env });
  return block();
};
global.fetch = async (url, options) => {
  if (!active()) return block();
  const target = new URL(url);
  if (target.origin !== "https://consent-canary.meter.dev") return block();
  const { status } = JSON.parse(fs.readFileSync(path.join(base, "receiver.json")));
  if (![200, 503].includes(status)) return block();
  const overlapFile = path.join(base, "overlap.json");
  if (target.pathname === "/logs/codex/transcript" && fs.existsSync(overlapFile)) {
    const overlap = JSON.parse(fs.readFileSync(overlapFile));
    const heldFile = path.join(base, "overlap-held.json");
    if (Date.now() >= overlap.expiresAt) throw Error("overlap-expired");
    let claimed = false;
    try {
      fs.writeFileSync(heldFile, JSON.stringify({ pid: process.pid, at: Date.now(),
        request: fs.readFileSync(path.join(base, "data/logs/.drain-once.request"), "utf8") }), { flag: "wx", mode: 0o600 });
      claimed = true;
    } catch (error) { if (error.code !== "EEXIST") throw error; }
    if (claimed) {
      const held = JSON.parse(fs.readFileSync(heldFile));
      held.callbackCount = fs.readFileSync(path.join(base, "callbacks.jsonl"), "utf8").split("\n").filter(Boolean).length;
      fs.writeFileSync(heldFile, JSON.stringify(held), { mode: 0o600 });
      const deadline = Math.min(overlap.expiresAt, Date.now() + 25000);
      while (true) {
        if (!active() || options.signal?.aborted || Date.now() >= deadline) throw Error("overlap-not-completed");
        const lock = JSON.parse(fs.readFileSync(path.join(base, "data/logs/.drain-once.worker.lock")));
        if (lock.pid !== process.pid) throw Error("overlap-lost-owner");
        const callbacks = fs.readFileSync(path.join(base, "callbacks.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
        const stop = callbacks.slice(held.callbackCount).find(c => c.label === overlap.label && c.hook === "stop.js" &&
          c.outcome === "candidate-completed" && Date.parse(c.at) >= held.at);
        const request = fs.readFileSync(path.join(base, "data/logs/.drain-once.request"), "utf8");
        if (stop && request !== held.request) {
          fs.writeFileSync(path.join(base, "overlap-release.json"), JSON.stringify({ pid: process.pid, at: Date.now(),
            stopAt: stop.at, newerTrigger: true }), { mode: 0o600, flag: "wx" });
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  }
  const id = crypto.randomUUID(), dir = path.join(base, status === 200 ? "received" : "attempts");
  fs.writeFileSync(path.join(dir, id + ".gz"), options.body, { mode: 0o600 });
  const headers = options.headers || {};
  fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify({ at: new Date().toISOString(),
    path: target.pathname, status, seq: headers["X-Chunk-Seq"] || null, reset: headers["X-Chunk-Reset"] || null }), { mode: 0o600 });
  return { ok: status === 200, status };
};

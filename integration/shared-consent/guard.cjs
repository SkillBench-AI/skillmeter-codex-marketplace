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
  if (command === process.execPath && args?.length === 1 && args[0] === path.join(base, "codex/scripts/drain_once.js"))
    return spawn(command, args, { ...options, env: process.env });
  return block();
};
global.fetch = async (url, options) => {
  if (!active()) return block();
  const target = new URL(url);
  if (target.origin !== "https://consent-canary.meter.dev") return block();
  const { status } = JSON.parse(fs.readFileSync(path.join(base, "receiver.json")));
  if (![200, 503].includes(status)) return block();
  const id = crypto.randomUUID(), dir = path.join(base, status === 200 ? "received" : "attempts");
  fs.writeFileSync(path.join(dir, id + ".gz"), options.body, { mode: 0o600 });
  const headers = options.headers || {};
  fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify({ at: new Date().toISOString(),
    path: target.pathname, status, seq: headers["X-Chunk-Seq"] || null, reset: headers["X-Chunk-Reset"] || null }), { mode: 0o600 });
  return { ok: status === 200, status };
};

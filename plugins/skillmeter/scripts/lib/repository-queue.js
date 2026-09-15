"use strict";
// Codex adapter of Claude's repository-queue model. The queue key also binds
// the principal and device, so signing in as someone else cannot adopt it.
const fs = require("node:fs");
const path = require("node:path");
const { safeReadJson } = require("./io");
const policyStore = require("./telemetry-store");
const { hmac, acquireLock, writeDurable } = require("./transcript-delta");

function consentStamp(scope) {
  const policy = policyStore.readPolicy();
  return JSON.stringify([policy.organizations[scope.org], policy.repositories[scope.repoKey]]);
}
function disposition(scope) {
  const policy = policyStore.readPolicy();
  if (policy.global.enabled === false) return "pause";
  if (policy.organizations[scope.org]?.enabled !== true ||
      policy.repositories[scope.repoKey]?.enabled !== true) return "delete";
  if (scope.consentStamp !== consentStamp(scope)) return "delete";
  return "send";
}
function context(root, scope, salt) {
  if (!policyStore.normalizeRepoKey(scope?.repoKey) || !scope.owner || !scope.deviceId) return null;
  const id = hmac(salt, JSON.stringify([scope.repoKey, scope.owner, scope.deviceId, scope.consentStamp]));
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const release = acquireLock(path.join(dir, "lock"));
  if (!release) return null;
  try {
    const file = path.join(dir, "repository.json");
    const existing = safeReadJson(file);
    if (!existing) writeDurable(file, JSON.stringify({ scope }));
    else if (JSON.stringify(existing.scope) !== JSON.stringify(scope)) {
      // Clones share a canonical queue; only the first checkout hint is kept.
      if (["repoKey", "owner", "deviceId", "consentStamp"].some(k => existing.scope[k] !== scope[k])) return null;
    }
    return { root: dir, scope: existing?.scope || scope, eventLog: path.join(dir, "events.jsonl") };
  } finally { release(); }
}
function list(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(n => /^[a-f0-9]{64}$/.test(n)).flatMap(name => {
    const dir = path.join(root, name), meta = safeReadJson(path.join(dir, "repository.json"));
    if (!policyStore.normalizeRepoKey(meta?.scope?.repoKey)) return [];
    return [{ root: dir, scope: meta.scope, eventLog: path.join(dir, "events.jsonl") }];
  });
}
function forFile(root, file) {
  return list(root).find(c => path.dirname(path.resolve(file)) === c.root) || null;
}
function withLock(context, fn) {
  const release = acquireLock(path.join(context.root, "lock"));
  if (!release) return null;
  try { return fn(); } finally { release(); }
}
function purge(context) {
  return withLock(context, () => {
    fs.rmSync(path.join(context.root, "poison"), { recursive: true, force: true });
    for (const name of fs.readdirSync(context.root)) {
      if (/^events\.jsonl(?:\.\d+)?(?:\.sent|\.meta)?$/.test(name)) fs.unlinkSync(path.join(context.root, name));
    }
  });
}
module.exports = { consentStamp, disposition, context, list, forFile, withLock, purge };

"use strict";

// Follow Claude's payload-removal/cursor-retention contract. Codex still has
// mixed event batches, so a local routing index authorizes each known record.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const queue = require("./transcript-delta");

function createRepositoryQueue(root, salt, allowed) {
  const index = path.join(root, "repository-routing");
  const key = cwd => queue.hmac(salt(), path.resolve(cwd)).slice(0, 12);
  const canonical = cwd => fs.realpathSync(cwd);
  function read(id, alias = true) {
    if (!/^[a-f0-9]{12}$/.test(id || "")) return null;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(index, `${id}.json`), "utf8"));
      if (state.canonical && alias) return read(state.canonical, false);
      if (typeof state.repoRoot !== "string" || !state.directories || typeof state.directories !== "object" || Array.isArray(state.directories) || !(state.epoch === 0 || typeof state.epoch === "string")) throw new Error("invalid-repository-routing");
      return state;
    }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  function register(cwd, repoRoot, revoke = false) {
    fs.mkdirSync(index, { recursive: true, mode: 0o700 });
    const canonicalRoot = canonical(repoRoot), id = key(canonicalRoot), file = path.join(index, `${id}.json`);
    const release = queue.acquireLock(`${file}.lock`);
    if (!release) throw new Error("repository-routing-busy");
    try {
      const state = read(id) || { repoRoot: canonicalRoot, epoch: 0, directories: {} };
      if (state.repoRoot !== canonicalRoot) throw new Error("repository-routing-mismatch");
      state.directories[key(cwd)] = path.resolve(cwd);
      state.directories[key(canonical(cwd))] = canonical(cwd);
      if (revoke) state.epoch = crypto.randomUUID();
      queue.writeDurable(file, JSON.stringify(state));
      if (key(repoRoot) !== id) queue.writeDurable(path.join(index, `${key(repoRoot)}.json`), JSON.stringify({ canonical: id }));
      return state;
    } finally { release(); }
  }
  function epoch(repoRoot) { return read(key(canonical(repoRoot)))?.epoch || 0; }
  function eventRoute(data) {
    const state = read(data?.repo_root);
    return state ? { epoch: state.epoch } : undefined;
  }
  function revokedScope(scope) {
    return (scope.queueEpoch || 0) !== epoch(scope.repoRoot);
  }
  // Unknown legacy rows retain their existing behavior; do not infer a repo
  // from a session ID. New indexed rows with missing routing state are held.
  function filter(bytes) {
    const kept = [], wire = [];
    let dropped = false;
    for (const line of bytes.toString().split("\n").filter(Boolean)) {
      let record;
      try { record = JSON.parse(line); } catch { kept.push(line); wire.push(line); continue; }
      if (!record || typeof record !== "object" || Array.isArray(record)) { kept.push(line); wire.push(line); continue; }
      const state = read(record?.data?.repo_root);
      if (record._queue && !state) return null;
      if (state) {
        const cwd = state.directories[record.data.cwd];
        if (!cwd) return null;
        if ((record._queue?.epoch || 0) !== state.epoch || !allowed(cwd)) {
          dropped = true;
          continue;
        }
      }
      kept.push(line);
      delete record._queue;
      wire.push(JSON.stringify(record));
    }
    return {
      kept: dropped ? (kept.length ? kept.join("\n") + "\n" : "") : bytes.toString(),
      wire: wire.length ? wire.join("\n") + "\n" : "",
    };
  }
  function pruneFile(file) {
    if (!fs.existsSync(file)) return null;
    const bytes = fs.readFileSync(file), result = filter(bytes);
    if (!result) return null;
    if (!result.kept) fs.unlinkSync(file);
    else if (result.kept !== bytes.toString()) queue.writeDurable(file, result.kept);
    return result;
  }
  function purgeEvents() {
    if (!fs.existsSync(root)) return true;
    let complete = true;
    for (const name of fs.readdirSync(root)) {
      if (!/^events\.jsonl\.\d+(?:\.sent)?$/.test(name)) continue;
      const file = path.join(root, name), release = queue.acquireLock(`${file}.lock`);
      if (!release) { complete = false; continue; } // in-flight delivery rechecks on completion
      try { if (!pruneFile(file)) complete = false; }
      catch { complete = false; console.error("[skillmeter] Repository payload cleanup deferred; routing unavailable"); }
      finally { release(); }
    }
    return complete;
  }
  return { register, epoch, eventRoute, revokedScope, pruneFile, purgeEvents };
}
module.exports = { createRepositoryQueue };

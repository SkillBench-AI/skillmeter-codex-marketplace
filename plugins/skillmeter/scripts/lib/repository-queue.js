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
  function acquireRoutingLock(file) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const release = queue.acquireLock(file);
      if (release) return release;
      if (attempt < 4) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    throw new Error("repository-routing-busy");
  }
  function register(cwd, repoRoot, revoke = false, prepareConsent) {
    fs.mkdirSync(index, { recursive: true, mode: 0o700 });
    const canonicalRoot = canonical(repoRoot), id = key(canonicalRoot), file = path.join(index, `${id}.json`);
    const release = acquireRoutingLock(`${file}.lock`);
    try {
      const state = read(id) || { repoRoot: canonicalRoot, epoch: 0, directories: {} };
      if (state.repoRoot !== canonicalRoot) throw new Error("repository-routing-mismatch");
      // Prepare/validate settings under the same lock as registration. Publish
      // the generation and choice before another hook can acquire this lock.
      const publishConsent = prepareConsent?.();
      const canonicalCwd = canonical(cwd);
      if (!revoke && !publishConsent && state.directories[key(cwd)] === path.resolve(cwd) &&
          state.directories[key(canonicalCwd)] === canonicalCwd && read(key(repoRoot))) return state;
      state.directories[key(cwd)] = path.resolve(cwd);
      state.directories[key(canonicalCwd)] = canonicalCwd;
      if (revoke) state.epoch = crypto.randomUUID();
      queue.writeDurable(file, JSON.stringify(state));
      if (key(repoRoot) !== id) queue.writeDurable(path.join(index, `${key(repoRoot)}.json`), JSON.stringify({ canonical: id }));
      publishConsent?.();
      return state;
    } finally { release(); }
  }
  function epoch(repoRoot) {
    if (!fs.existsSync(index)) return 0;
    const id = key(canonical(repoRoot));
    const release = acquireRoutingLock(path.join(index, `${id}.json.lock`));
    try { return read(id)?.epoch || 0; }
    finally { release(); }
  }
  function eventRoute(data) {
    const state = read(data?.repo_root);
    return state ? { epoch: state.epoch } : undefined;
  }
  function revokedScope(scope) {
    return (scope.queueEpoch || 0) !== epoch(scope.repoRoot);
  }
  // Unknown legacy rows retain their existing behavior; do not infer a repo
  // from a session ID. New indexed rows with missing routing state are held.
  function filter(bytes, authorize) {
    const kept = [], wire = [], ready = [], held = [];
    const decisions = new Map(), states = new Map();
    let dropped = false;
    for (const line of bytes.toString().split("\n").filter(Boolean)) {
      let record;
      try { record = JSON.parse(line); } catch { kept.push(line); ready.push(line); wire.push(line); continue; }
      if (!record || typeof record !== "object" || Array.isArray(record)) { kept.push(line); ready.push(line); wire.push(line); continue; }
      const id = record?.data?.repo_root;
      if (!states.has(id)) states.set(id, read(id));
      const state = states.get(id);
      let blocked = Boolean(record._queue && !state);
      if (state) {
        const cwd = state.directories[record.data.cwd];
        if (!cwd) blocked = true;
        else if ((record._queue?.epoch || 0) !== state.epoch) {
          dropped = true;
          continue;
        } else if (authorize) {
          if (!decisions.has(cwd)) decisions.set(cwd, allowed(cwd));
          blocked = !decisions.get(cwd);
        }
      }
      kept.push(line);
      if (blocked) { held.push(line); continue; }
      ready.push(line);
      delete record._queue;
      wire.push(JSON.stringify(record));
    }
    const ndjson = lines => lines.length ? lines.join("\n") + "\n" : "";
    return {
      kept: dropped ? ndjson(kept) : bytes.toString(),
      ready: ndjson(ready), held: ndjson(held),
      wire: !wire.length && held.length ? null : ndjson(wire),
    };
  }
  function pruneFile(file, authorize = true) {
    if (!fs.existsSync(file)) return null;
    const bytes = fs.readFileSync(file), result = filter(bytes, authorize);
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
      try {
        const result = pruneFile(file, false);
        if (!result || result.held) complete = false;
      }
      catch { complete = false; console.error("[skillmeter] Repository payload cleanup deferred; routing unavailable"); }
      finally { release(); }
    }
    return complete;
  }
  return { register, epoch, eventRoute, revokedScope, pruneFile, purgeEvents };
}
module.exports = { createRepositoryQueue };

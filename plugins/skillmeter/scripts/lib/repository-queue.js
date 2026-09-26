"use strict";

// Follow Claude's payload-removal/cursor-retention contract. Codex still has
// mixed event batches, so a local routing index authorizes each known record.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const queue = require("./transcript-delta");
const { validCounters, compareCounters } = require("./consent-counters");

function createRepositoryQueue(root, salt, allowed, sharedPolicy = () => null) {
  const index = path.join(root, "repository-routing");
  const key = cwd => queue.hmac(salt(), path.resolve(cwd)).slice(0, 12);
  const canonical = cwd => fs.realpathSync(cwd);
  function read(id, alias = true) {
    if (!/^[a-f0-9]{12}$/.test(id || "")) return null;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(index, `${id}.json`), "utf8"));
      if (state.canonical && alias) return read(state.canonical, false);
      if (typeof state.repoRoot !== "string" || !state.directories || typeof state.directories !== "object" || Array.isArray(state.directories) || !(state.epoch === 0 || typeof state.epoch === "string")) throw new Error("invalid-repository-routing");
      if ((state.sharedStamp !== undefined && typeof state.sharedStamp !== "string") ||
          (state.sharedPolicySeen !== undefined && typeof state.sharedPolicySeen !== "boolean") ||
          (state.sharedDeliveryToken !== undefined && typeof state.sharedDeliveryToken !== "string") ||
          (state.sharedRepoKey !== undefined && typeof state.sharedRepoKey !== "string")) throw new Error("invalid-shared-policy-routing");
      if ((state.revocationsSeen !== undefined && !validCounters(state.revocationsSeen)) ||
          (state.sharedCounterHeld !== undefined && typeof state.sharedCounterHeld !== "boolean") ||
          (state.sharedRevoked !== undefined && typeof state.sharedRevoked !== "boolean") ||
          (state.sharedAcknowledgement !== undefined && typeof state.sharedAcknowledgement !== "string")) throw new Error("invalid-counter-routing");
      if (state.previousRepositories !== undefined && (!Array.isArray(state.previousRepositories) ||
          state.previousRepositories.some(entry => !entry || typeof entry.key !== "string" ||
            typeof entry.token !== "string" || typeof entry.revoked !== "boolean" ||
            (entry.revocationsSeen !== undefined && !validCounters(entry.revocationsSeen))))) throw new Error("invalid-previous-repository-routing");
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
  // Called under the routing lock. Tokens identify immutable queue generations;
  // only a counter increase or explicit OFF revokes an existing generation.
  function synchronize(state) {
    const policy = sharedPolicy(state.repoRoot);
    let changed = false;
    const effective = policy?.key ? policy : sharedPolicy(state.repoRoot, state.sharedRepoKey);
    // Deleting an observed policy cannot restore a legacy local grant.
    if (effective && effective.stamp !== null && !(state.sharedPolicySeen && effective.reason === "absent")) {
      if (!state.sharedPolicySeen && effective.reason !== "absent") {
        state.sharedPolicySeen = true;
        changed = true;
      }
      const changedRepository = effective.key && effective.key !== state.sharedRepoKey;
      const counters = effective.revocations;
      const comparison = validCounters(counters) && validCounters(state.revocationsSeen)
        ? compareCounters(counters, state.revocationsSeen) : null;
      const adoptCounters = validCounters(counters) && !validCounters(state.revocationsSeen);
      const acknowledgement = effective.acknowledgement ?? "[null,null]";
      const changedAcknowledgement = state.sharedAcknowledgement !== undefined && state.sharedAcknowledgement !== acknowledgement;
      if (!state.sharedDeliveryToken || changedRepository || adoptCounters || changedAcknowledgement || comparison === "higher" ||
          (effective.revoked === true && !state.sharedRevoked)) {
        // Old random-token rows lack a proven counter. Keep their attribution
        // held rather than silently interpreting them as zero on upgrade.
        if (state.sharedRepoKey && state.sharedDeliveryToken) {
          state.previousRepositories ||= [];
          state.previousRepositories.push({ key: state.sharedRepoKey, token: state.sharedDeliveryToken,
            revoked: !changedRepository && (comparison === "higher" || effective.revoked === true),
            ...(validCounters(state.revocationsSeen) ? { revocationsSeen: state.revocationsSeen } : {}) });
        }
        if (effective.key) state.sharedRepoKey = effective.key;
        state.sharedDeliveryToken = crypto.randomUUID();
        if (validCounters(counters)) {
          // Repository counters belong to an exact identity; organization
          // counters also apply when a checkout switches within that org.
          const remembered = { ...counters };
          for (const entry of state.previousRepositories || []) {
            if (!validCounters(entry.revocationsSeen)) continue;
            if (entry.key.split("/")[1] === effective.key?.split("/")[1]) {
              remembered.org = Math.max(remembered.org, entry.revocationsSeen.org);
            }
            if (entry.key === effective.key) remembered.repo = Math.max(remembered.repo, entry.revocationsSeen.repo);
          }
          state.revocationsSeen = remembered;
        } else if (changedRepository) delete state.revocationsSeen;
        changed = true;
      }
      if (state.sharedAcknowledgement !== acknowledgement) { state.sharedAcknowledgement = acknowledgement; changed = true; }
      if (state.sharedRevoked !== Boolean(effective.revoked)) { state.sharedRevoked = Boolean(effective.revoked); changed = true; }
      const held = validCounters(counters) && validCounters(state.revocationsSeen) &&
        (counters.org < state.revocationsSeen.org || counters.repo < state.revocationsSeen.repo);
      if (state.sharedCounterHeld !== held) { state.sharedCounterHeld = held; changed = true; }
      if (state.sharedStamp !== effective.stamp) { state.sharedStamp = effective.stamp; changed = true; }
    }
    for (const entry of state.previousRepositories || []) {
      const previous = sharedPolicy(state.repoRoot, entry.key);
      if (!entry.revoked && (previous?.revoked || (validCounters(previous?.revocations) &&
          validCounters(entry.revocationsSeen) && compareCounters(previous.revocations, entry.revocationsSeen) === "higher"))) {
        entry.revoked = true;
        changed = true;
      }
    }
    return changed;
  }
  function current(id) {
    const original = read(id);
    if (!original) return null;
    const canonicalId = key(original.repoRoot);
    const file = path.join(index, `${canonicalId}.json`);
    const release = acquireRoutingLock(`${file}.lock`);
    try {
      const state = read(canonicalId);
      if (state && synchronize(state)) queue.writeDurable(file, JSON.stringify(state));
      return state;
    } finally { release(); }
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
      const changed = synchronize(state);
      const canonicalCwd = canonical(cwd);
      if (!changed && !revoke && !publishConsent && state.directories[key(cwd)] === path.resolve(cwd) &&
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
    return current(key(repoRoot))?.epoch || 0;
  }
  function eventRoute(data) {
    const state = read(data?.repo_root);
    return state ? { epoch: state.epoch, sharedStamp: state.sharedDeliveryToken } : undefined;
  }
  function revokedScope(scope) {
    if (!fs.existsSync(index)) return false;
    const state = current(key(scope.repoRoot));
    return (scope.queueEpoch || 0) !== (state?.epoch || 0) ||
      !!state?.previousRepositories?.some(entry => entry.token === scope.sharedStamp && entry.revoked);
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
      if (!states.has(id)) states.set(id, current(id));
      const state = states.get(id);
      let blocked = Boolean(record._queue && !state);
      if (state) {
        const cwd = state.directories[record.data.cwd];
        if (!cwd) blocked = true;
        else if ((record._queue?.epoch || 0) !== state.epoch) {
          dropped = true;
          continue;
        } else if (state.previousRepositories?.some(entry => entry.token === record._queue?.sharedStamp && entry.revoked)) {
          dropped = true;
          continue;
        } else if (authorize && state.sharedCounterHeld) {
          blocked = true;
        } else if (authorize && (record._queue?.sharedStamp !== state.sharedDeliveryToken) &&
                   (record._queue?.sharedStamp !== undefined || state.sharedPolicySeen)) {
          blocked = true;
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
    for (const directory of [root, path.join(root, "poison")]) {
      if (!fs.existsSync(directory)) continue;
      for (const name of fs.readdirSync(directory)) {
        if (!/^events\.jsonl\.\d+(?:\.sent)?$/.test(name)) continue;
        const file = path.join(directory, name);
        // Delivery can rename or partition the source while holding its lock.
        // Sent and quarantined copies belong to that same batch lock domain.
        const batch = path.join(root, name.replace(/\.sent$/, ""));
        const release = queue.acquireLock(`${batch}.lock`);
        if (!release) { complete = false; continue; }
        try {
          const result = pruneFile(file, false);
          if (!result || result.held) complete = false;
        }
        catch { complete = false; console.error("[skillmeter] Repository payload cleanup deferred; routing unavailable"); }
        finally { release(); }
      }
    }
    return complete;
  }
  function requiresSharedPolicy(repoRoot) {
    if (!repoRoot || !fs.existsSync(index)) return false;
    return read(key(repoRoot))?.sharedPolicySeen === true;
  }
  function counterHeld(repoRoot) {
    return Boolean(repoRoot && fs.existsSync(index) && current(key(repoRoot))?.sharedCounterHeld);
  }
  function hasRevoked(file) {
    if (!fs.existsSync(file)) return false;
    const bytes = fs.readFileSync(file);
    return filter(bytes, false).kept !== bytes.toString();
  }
  return { register, epoch, eventRoute, revokedScope, pruneFile, purgeEvents, requiresSharedPolicy, counterHeld, hasRevoked };
}
module.exports = { createRepositoryQueue };

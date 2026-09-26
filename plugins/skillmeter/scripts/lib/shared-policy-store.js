"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { policyPathIsAbsent } = require("./shared-telemetry-policy");

// Schema, key normalization, lock name and atomic writes follow Claude's
// telemetry-store.js. Unlike its legacy reader, ordinary writes never repair
// invalid policy. See the canonical shared-consent ADR.
const FIELDS = ["schema_version", "revision", "global", "organizations", "repositories"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const record = value => object(value) && typeof value.enabled === "boolean" &&
  (value.decided_at === undefined || integer(value.decided_at)) &&
  (value.consent_version === undefined || [1, 2].includes(value.consent_version));

function error(code, message) {
  return Object.assign(new Error(message), { code });
}

// Temp files are uniquely named and never read back. Their cleanup is best
// effort: a failure here must not replace the outcome of the write it follows,
// which has already committed or already failed with its own error.
function discard(temp) {
  try { fs.unlinkSync(temp); } catch {}
}

// A renamed or linked directory entry is only durable once its directory is
// synced. Without this, a revoking write could reappear as the old grant after
// a crash, and a lost marker would read as first use instead of POLICY_MISSING.
function syncDir(dir) {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function validatePolicy(policy) {
  if (!object(policy) || policy.schema_version !== 1 || !integer(policy.revision) ||
      Object.keys(policy).some(key => !FIELDS.includes(key)) || !record(policy.global) ||
      !object(policy.organizations) || !object(policy.repositories) ||
      !Object.values(policy.organizations).every(record) || !Object.values(policy.repositories).every(record)) {
    throw error("INVALID_POLICY", "Shared policy is invalid or unsupported; repair it explicitly before changing consent.");
  }
  return policy;
}

function normalizeRepoKey(value) {
  if (typeof value !== "string") return "";
  const match = value.trim().toLowerCase().match(/^(?:github\.com\/)?([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/);
  return match ? `github.com/${match[1]}/${match[2].replace(/\.git$/, "")}` : "";
}

function createSharedPolicyStore({ file, observedFile }) {
  if (!file || !observedFile || path.resolve(file) === path.resolve(observedFile)) {
    throw new Error("Separate shared policy and client observation paths are required.");
  }
  const lockFile = `${file}.lock`;

  function observed(mark = false, onCreate = () => {}) {
    try {
      if (mark && !observed()) {
        fs.mkdirSync(path.dirname(observedFile), { recursive: true, mode: 0o700 });
        const temp = `${observedFile}.${randomUUID()}.tmp`;
        let fd;
        try {
          fd = fs.openSync(temp, "wx", 0o600);
          fs.writeFileSync(fd, "1\n"); fs.fsyncSync(fd);
          fs.linkSync(temp, observedFile);
          syncDir(path.dirname(observedFile));
          onCreate(fs.fstatSync(fd));
        } catch (err) { if (err.code !== "EEXIST") throw err; }
        finally {
          if (fd !== undefined) fs.closeSync(fd);
          discard(temp);
        }
      }
      if (!fs.lstatSync(observedFile).isFile() || fs.readFileSync(observedFile, "utf8") !== "1\n") throw new Error("invalid marker");
      return true;
    } catch (err) {
      if (!mark && err.code === "ENOENT" && policyPathIsAbsent(observedFile)) return false;
      throw error("POLICY_OBSERVATION_FAILED", "Cannot persist or read shared-policy observation; check client data permissions.");
    }
  }

  function readPolicy() {
    let raw;
    try {
      // Renaming onto a file symlink would detach this client from its target.
      if (!fs.lstatSync(file).isFile()) throw new Error("not a regular policy file");
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT" && policyPathIsAbsent(file)) {
        if (observed()) throw error("POLICY_MISSING", "Previously observed shared policy is missing; restore it before changing consent.");
        return null;
      }
      throw error("INVALID_POLICY", "Cannot read shared policy; check its path and permissions before changing consent.");
    }
    observed(true);
    let policy;
    try { policy = JSON.parse(raw); }
    catch { throw error("INVALID_POLICY", "Shared policy contains invalid JSON; repair it explicitly."); }
    return validatePolicy(policy);
  }

  function withLock(callback) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let fd;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { fd = fs.openSync(lockFile, "wx", 0o600); break; }
      catch (err) {
        if (err.code !== "EEXIST") throw err;
        // Claude's lock has no owner identity. Age alone cannot prove that its
        // writer exited, so leave even an old lock for explicit recovery.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    if (fd === undefined) throw error("POLICY_BUSY", "Shared policy is busy; retry after the other writer finishes.");
    const token = randomUUID();
    const acquiredAt = Date.now();
    const owned = () => {
      try { return fs.readFileSync(lockFile, "utf8") === token; }
      catch { return false; }
    };
    try {
      fs.writeFileSync(fd, token);
      return callback(() => {
        // Older Claude writers can reclaim a lock at ten seconds. An expired
        // or replaced lock must not commit or remove its replacement.
        if (Date.now() - acquiredAt >= 10_000 || !owned()) throw error("POLICY_BUSY", "Shared policy lock changed; reload and retry.");
      });
    } finally {
      fs.closeSync(fd);
      if (owned()) fs.unlinkSync(lockFile);
    }
  }

  function mutate(mutator, options) {
    const expected = options?.expectedRevision;
    if (expected !== null && !integer(expected)) {
      throw error("EXPECTED_REVISION_REQUIRED", "Read the policy first and supply its revision (null only for first use).");
    }
    // Check paths before creating directories or acquiring a lock.
    readPolicy();
    return withLock(assertOwned => {
      const previous = readPolicy();
      if ((previous?.revision ?? null) !== expected) {
        throw error("STALE_POLICY", "Shared policy changed; reload the choices and confirm again.");
      }
      const policy = previous || { schema_version: 1, revision: 0, global: { enabled: true }, organizations: {}, repositories: {} };
      mutator(policy);
      policy.revision++;
      validatePolicy(policy);
      let createdMarker;
      observed(true, stat => { createdMarker = stat; });
      const temp = `${file}.tmp.${process.pid}.${randomUUID()}`;
      let fd;
      try {
        fd = fs.openSync(temp, "wx", 0o600);
        fs.writeFileSync(fd, JSON.stringify(policy, null, 2) + "\n");
        fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        assertOwned();
        fs.renameSync(temp, file);
        syncDir(path.dirname(file));
      } catch (err) {
        // A failed first write has not observed a policy. Roll back only this
        // attempt's marker, under our lock, while the policy is still absent.
        // Uncertain ownership or cleanup failure deliberately leaves the hold.
        if (!previous && createdMarker) {
          try {
            assertOwned();
            const current = fs.lstatSync(observedFile);
            if (current.dev === createdMarker.dev && current.ino === createdMarker.ino && policyPathIsAbsent(file)) {
              fs.unlinkSync(observedFile);
            }
          } catch { /* Preserve the original write error and fail closed. */ }
        }
        throw err;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        discard(temp);
      }
      return policy;
    });
  }

  function decision(enabled, previous) {
    if (typeof enabled !== "boolean") throw new TypeError("Telemetry consent must be boolean.");
    return { enabled, decided_at: Math.max(Date.now(), (previous?.decided_at ?? 0) + 1), source: "user" };
  }

  function setRepositoryOverride(repoKey, enabled, options) {
    const key = normalizeRepoKey(repoKey);
    if (!key || key.endsWith("/")) throw new Error("A canonical GitHub repository is required.");
    if (enabled === true && options?.acknowledged !== true) {
      throw error("ACKNOWLEDGEMENT_REQUIRED", "Enabling requires acknowledgement of machine-wide consent scope.");
    }
    return mutate(policy => {
      policy.repositories[key] = {
        ...decision(enabled, policy.repositories[key]),
        ...(enabled === true && options?.acknowledged === true ? { consent_version: 2 } : {}),
      };
    }, options);
  }

  function setGlobalEnabled(enabled, options) {
    return mutate(policy => { policy.global = decision(enabled, policy.global); }, options);
  }

  return { readPolicy, setRepositoryOverride, setGlobalEnabled };
}

module.exports = { createSharedPolicyStore };

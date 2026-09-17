const { execSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Credentials are intentionally shared with the SkillMeter Claude Code plugin so
// that the same device.id and hash salt apply across both agents. The SkillBench
// analyzer keys off ResourceAttributes['service.device.id'] and downstream
// dashboards expect a single stable identity per machine. The license JWT and
// allowed-org list are shared too: a user who signs in via either plugin is
// authenticated for both.
const CRED_FILE = path.join(os.homedir(), ".skillbench", "credentials.json");

const KEYCHAIN_SERVICES = {
  device_id: "com.skillbench.device-id",
  hash_salt: "com.skillbench.hash-salt",
  license_jwt: "com.skillbench.license",
};

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(CRED_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeStore(data) {
  const dir = path.dirname(CRED_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Atomic write: write payload to a sibling tempfile, fsync, then rename into
  // place. POSIX rename within the same filesystem is atomic — readers see
  // either the old file or the new file, never a partial write. This matters
  // for the license JWT: commitSignin re-reads and writes under a signed-out
  // race, and a half-written token would brick auth for both plugins.
  const tempPath = `${CRED_FILE}.tmp.${process.pid}.${Date.now()}`;
  let fd;
  try {
    fd = fs.openSync(tempPath, "w", 0o600);
    fs.writeSync(fd, JSON.stringify(data, null, 2) + "\n");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, CRED_FILE);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tempPath); } catch {}
    throw err;
  }
}

// Raw file text, for detecting an interleaved write byte-for-byte. null when
// the file is absent or unreadable.
function readRaw() {
  try { return fs.readFileSync(CRED_FILE, "utf8"); }
  catch { return null; }
}

const PREEMPTED = Symbol("credential-store-preempted");

// One locked read/modify/write attempt. Returns PREEMPTED when the state we
// based the mutation on is no longer the state on disk.
function mutateStoreOnce(fn) {
  fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true, mode: 0o700 });
  const { acquireLock } = require("./lib/credential-lock");
  const deadline = Date.now() + 1000;
  let release;
  while (!(release = acquireLock(`${CRED_FILE}.lock`))) {
    if (Date.now() >= deadline) throw new Error("credential-store-busy");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try {
    const baseline = readRaw();
    const store = readStore();
    const result = fn(store);
    if (result === false) return false;
    // Fence before persisting. Holding the lock is not by itself proof that we
    // still hold it: the age backstop reaps a holder that was paused long
    // enough (SIGSTOP, swap, a suspended VM), and a replacement writer may have
    // committed in the meantime. Writing our pre-pause snapshot would roll that
    // back silently — the shared file has no other guard, since commitSignin's
    // `expected` check is optional and signin.js omits it.
    if (!release.stillHeld() || readRaw() !== baseline) return PREEMPTED;
    writeStore(store);
    _cache = store;
    return result === undefined ? true : result;
  } finally { release(); }
}

// All Codex writers participate in the same read/modify/write lock. Other
// clients must adopt this protocol too for cross-client serialization.
//
// A preempted attempt is retried rather than failed: `fn` is a transform over
// whatever the store currently holds, so re-running it against the newer state
// is exactly the intended outcome — our change lands on top of theirs instead
// of replacing it.
function mutateStore(fn) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outcome = mutateStoreOnce(fn);
    if (outcome !== PREEMPTED) return outcome;
  }
  throw new Error("credential-store-busy");
}

// Snapshot disk state before a network exchange, never the process cache.
// The generation also detects sign-out/sign-in cycles that reuse a JWT.
function recoverySnapshot() {
  const store = readStore();
  return {
    token: store.license_jwt || null,
    generation: store.auth_generation || null,
    deviceId: store.device_id || null,
    signedOut: store.signed_out === true,
  };
}

function snapshotMatches(store, expected) {
  return !expected.signedOut && store.signed_out !== true &&
    (store.license_jwt || null) === expected.token &&
    (store.auth_generation || null) === expected.generation &&
    (store.device_id || null) === expected.deviceId;
}

function isRecoveryCurrent(expected) {
  return snapshotMatches(readStore(), expected);
}

function commitRefresh(jwt, expected) {
  return mutateStore(store => {
    if (!snapshotMatches(store, expected)) return false;
    store.license_jwt = jwt;
  });
}

function readKeychain(service) {
  const account = process.env.USER || process.env.USERNAME || "";
  if (!account) return null;
  try {
    const result = execSync(
      `security find-generic-password -a "${account}" -s "${service}" -w 2>/dev/null`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return result.trim() || null;
  } catch {
    return null;
  }
}

function migrateFromKeychain() {
  const store = readStore();
  let migrated = false;

  for (const [key, service] of Object.entries(KEYCHAIN_SERVICES)) {
    if (!store[key]) {
      const val = readKeychain(service);
      if (val) {
        store[key] = val;
        migrated = true;
      }
    }
  }

  if (migrated) {
    mutateStore(current => {
      for (const key of Object.keys(KEYCHAIN_SERVICES)) {
        if (key === "license_jwt" && current.signed_out) continue;
        if (!current[key] && store[key]) current[key] = store[key];
      }
    });
    console.error("[skillmeter] Migrated credentials from Keychain to ~/.skillbench/credentials.json");
  }

  return readStore();
}

function migrateFromFallbackFiles(logDir) {
  // Auth entrypoints (signin/signout) call getDeviceId() without a logDir.
  // The legacy fallback files only ever lived next to a hook's LOG_DIR, so
  // there's nothing to migrate when logDir is absent.
  if (!logDir) return readStore();

  const store = readStore();
  let migrated = false;

  const legacyMap = {
    device_id: path.join(logDir, ".device-id"),
    hash_salt: path.join(logDir, ".hash-salt"),
  };

  for (const [key, filePath] of Object.entries(legacyMap)) {
    if (!store[key]) {
      try {
        if (fs.existsSync(filePath)) {
          const val = fs.readFileSync(filePath, "utf8").trim();
          if (val) {
            store[key] = val;
            migrated = true;
          }
        }
      } catch {}
    }
  }

  if (migrated) {
    mutateStore(current => {
      for (const key of Object.keys(legacyMap)) {
        if (!current[key] && store[key]) current[key] = store[key];
      }
    });
    console.error("[skillmeter] Migrated credentials from legacy fallback files");
  }

  return readStore();
}

let _cache = null;

function loadStore(logDir) {
  if (_cache) return _cache;

  _cache = readStore();

  const needed = !_cache.device_id || !_cache.hash_salt;
  if (needed) {
    _cache = migrateFromKeychain();
    _cache = migrateFromFallbackFiles(logDir);
  }

  return _cache;
}

// Create-if-absent under the writer lock. A busy lock here almost always means
// a sibling hook is creating the very same field — several fire at once on a
// machine's first session — so we re-read instead of propagating the timeout.
// getDeviceId/getOrCreateHashSalt are called on the hot hook path, where a
// throw would fail the hook outright; every other writer keeps fail-fast.
function ensureIdentityField(logDir, key, create) {
  const store = loadStore(logDir);
  if (store[key]) return store[key];
  try {
    mutateStore(current => {
      if (!current[key]) current[key] = create();
    });
  } catch (err) {
    if (err && err.message === "credential-store-busy") {
      const fresh = readStore();
      _cache = fresh;
      if (fresh[key]) return fresh[key];
    }
    throw err;
  }
  return _cache[key];
}

function getDeviceId(logDir) {
  return ensureIdentityField(logDir, "device_id", () =>
    crypto.randomUUID().toUpperCase()
  );
}

function getOrCreateHashSalt(logDir) {
  return ensureIdentityField(logDir, "hash_salt", () =>
    crypto.randomBytes(16).toString("hex")
  );
}

function getLicenseToken(logDir) {
  const store = loadStore(logDir);
  return store.license_jwt || null;
}

/**
 * Read the license JWT straight from disk, bypassing the in-process cache.
 *
 * The retry daemon lives for hours and can outlast several sign-ins, sign-outs
 * and token rotations performed by other processes. A cached read would pin it
 * to the token that existed when it started, so the upload path uses this.
 *
 * A fresh read that finds nothing means nothing: we never fall back to a token
 * this process cached earlier, because that token may have been signed out or
 * removed by another client in the meantime. The one thing still worth doing is
 * the one-time Keychain / legacy-file migration for a pre-migration install —
 * and only when the fresh store shows no sign-out. That migration writes
 * through to disk, so we re-read from disk rather than trusting its return.
 *
 * @param {string} [logDir] - legacy fallback location, for migration only.
 * @returns {string|null} the stored license JWT, or null.
 */
function getLicenseTokenUncached(logDir) {
  const store = readStore();
  if (store.signed_out === true) return null;
  if (store.license_jwt) return store.license_jwt;
  loadStore(logDir);
  return readStore().license_jwt || null;
}

function setLicenseToken(jwt) {
  mutateStore(store => {
    if (jwt) store.license_jwt = jwt;
    else delete store.license_jwt;
    store.auth_generation = crypto.randomUUID();
  });
}

// ---------------------------------------------------------------------------
// License-JWT expiry hint
// ---------------------------------------------------------------------------

/**
 * Decode the payload section of a JWT without verifying the signature.
 * Only safe to use for local expiry hints; never trust the contents for
 * authorization decisions. Kept internal so the storage layer can answer
 * `isLicenseTokenExpired` without pulling in lib/jwt.
 */
function decodeJwtPayloadUnsafe(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

// Matches the VS Code extension's TOKEN_EXPIRY_SKEW_MS (5 min). Refresh fires
// proactively while the JWT is still technically valid so requests in flight
// don't cross the expiry boundary.
const LICENSE_EXPIRY_SKEW_SECONDS = 5 * 60;

/**
 * Return true when the given JWT is missing, malformed, or its `exp` claim
 * lies within `skewSeconds` of now. Absent/malformed tokens are treated as
 * expired so callers don't need to double-check.
 */
function isLicenseTokenExpired(token, skewSeconds = LICENSE_EXPIRY_SKEW_SECONDS) {
  if (!token) return true;
  const payload = decodeJwtPayloadUnsafe(token);
  if (!payload || typeof payload.exp !== "number") return true;
  return payload.exp <= Math.floor(Date.now() / 1000) + skewSeconds;
}

// ---------------------------------------------------------------------------
// Sign-in / sign-out lifecycle
// ---------------------------------------------------------------------------

// `signed_out` is set by the signout flow. It blocks the silent gh fallback so
// a still-authenticated gh CLI doesn't auto-resignin on the next SessionStart.
// `telemetry_disabled` is the machine-global kill switch shared by CLI toggles
// and signout; hooks and drains must not upload while it is true.
// `markEngaged()` (called from signin) clears both sentinels.
//
// Reads bypass the cache so a setter run by another process is reflected
// immediately — relevant when signin runs as a long-lived background poll while
// the user might invoke signout from a fresh hook process.
function getSignedOut() {
  return readStore().signed_out === true;
}

function getTelemetryDisabled() {
  return readStore().telemetry_disabled === true;
}

function setTelemetryDisabled(disabled) {
  mutateStore(store => {
    if (disabled) store.telemetry_disabled = true;
    else delete store.telemetry_disabled;
  });
}

// Keep identity while invalidating every in-flight authentication exchange.
function signOut() {
  mutateStore(store => {
    delete store.license_jwt;
    delete store.allowed_github_orgs;
    delete store.orgs_explicitly_set;
    store.signed_out = true;
    store.telemetry_disabled = true;
    store.auth_generation = crypto.randomUUID();
  });
}

function markEngaged() {
  mutateStore(store => {
    delete store.signed_out;
    delete store.telemetry_disabled;
    store.auth_generation = crypto.randomUUID();
  });
}

function normalizeOrgs(orgs) {
  if (!Array.isArray(orgs)) return [];
  return Array.from(
    new Set(
      orgs
        .filter((o) => typeof o === "string")
        .map((o) => o.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

// Persist a freshly-issued license atomically. Re-reads the store at write time
// and aborts if signout fired while the license issuance was in flight — the
// user's most recent intent wins. Returns true when the license was written,
// false when it was discarded.
//
// When `orgs` is an empty array, we store it explicitly as [] to distinguish
// "intentionally narrowed to zero orgs" from "not signed in" (missing field).
function commitSignin({ jwt, orgs, expected }) {
  return mutateStore(store => {
    if (store.signed_out === true) return false;
    if (expected && !snapshotMatches(store, expected)) return false;
    store.license_jwt = jwt;
    store.allowed_github_orgs = normalizeOrgs(orgs);
    store.orgs_explicitly_set = true;
    store.auth_generation = crypto.randomUUID();
  });
}

/**
 * GitHub identities (user login + org logins) the activated user belongs to.
 * Empty array means "not activated" OR "intentionally narrowed to zero orgs".
 * Use hasExplicitOrgScope() to distinguish these cases. Stored at sign-in for
 * future repo-scope gating parity with the Claude plugin.
 */
function getAllowedGitHubOrgs() {
  const store = loadStore();
  const orgs = store.allowed_github_orgs;
  if (!Array.isArray(orgs)) return [];
  return orgs;
}

/**
 * Returns true if the user has signed in and explicitly set an org scope
 * (even if that scope is empty). This distinguishes "intentionally narrowed
 * to zero orgs" from "never signed in".
 */
function hasExplicitOrgScope() {
  const store = loadStore();
  return store.orgs_explicitly_set === true;
}

// Long-running transcript drains must observe another process signing out or
// narrowing org scope. Read-only refresh; never migrate or write credentials.
function refreshFromDisk() { _cache = readStore(); }

module.exports = {
  refreshFromDisk,
  getDeviceId,
  getOrCreateHashSalt,
  getLicenseToken,
  getLicenseTokenUncached,
  setLicenseToken,
  recoverySnapshot,
  isRecoveryCurrent,
  commitRefresh,
  // The locked read/modify/write primitive every writer above goes through.
  // Exported so the race suite can drive a preemption from inside a mutation.
  mutateStore,
  isLicenseTokenExpired,
  getAllowedGitHubOrgs,
  hasExplicitOrgScope,
  // Atomic sign-in lifecycle — prefer these over the lower-level set* helpers
  // when adjusting more than one field, so partial writes can't race.
  commitSignin,
  markEngaged,
  signOut,
  getSignedOut,
  getTelemetryDisabled,
  setTelemetryDisabled,
  CRED_FILE,
};

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
    writeStore(store);
    console.error("[skillmeter] Migrated credentials from Keychain to ~/.skillbench/credentials.json");
  }

  return store;
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
    writeStore(store);
    console.error("[skillmeter] Migrated credentials from legacy fallback files");
  }

  return store;
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

function getDeviceId(logDir) {
  const store = loadStore(logDir);
  if (store.device_id) return store.device_id;

  const newId = crypto.randomUUID().toUpperCase();
  store.device_id = newId;
  writeStore(store);
  _cache = store;
  console.error("[skillmeter] New device ID created");
  return newId;
}

function getOrCreateHashSalt(logDir) {
  const store = loadStore(logDir);
  if (store.hash_salt) return store.hash_salt;

  const newSalt = crypto.randomBytes(16).toString("hex");
  store.hash_salt = newSalt;
  writeStore(store);
  _cache = store;
  console.error("[skillmeter] New hash salt created");
  return newSalt;
}

function getLicenseToken(logDir) {
  const store = loadStore(logDir);
  return store.license_jwt || null;
}

function setLicenseToken(jwt) {
  const store = readStore();
  if (jwt) {
    store.license_jwt = jwt;
  } else {
    // Empty/falsey clears the stored token (used by the 401/403 retry path
    // and force-refresh) without touching device identity.
    delete store.license_jwt;
  }
  writeStore(store);
  _cache = store;
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
  const store = readStore();
  if (disabled) {
    store.telemetry_disabled = true;
  } else {
    delete store.telemetry_disabled;
  }
  writeStore(store);
  _cache = store;
}

// Drop license + org list atomically. Preserves device_id and hash_salt so the
// machine identity survives a sign-out / sign-in cycle.
function signOut() {
  const store = readStore();
  delete store.license_jwt;
  delete store.allowed_github_orgs;
  delete store.orgs_explicitly_set;
  store.signed_out = true;
  store.telemetry_disabled = true;
  writeStore(store);
  _cache = store;
}

// Called when the user explicitly signs in — clears the signed-out sentinel so
// the next gh attempt is unblocked.
function markEngaged() {
  const store = readStore();
  delete store.signed_out;
  delete store.telemetry_disabled;
  writeStore(store);
  _cache = store;
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
function commitSignin({ jwt, orgs }) {
  const store = readStore();
  if (store.signed_out === true) return false;
  store.license_jwt = jwt;
  store.allowed_github_orgs = normalizeOrgs(orgs);
  // Mark that org scope was explicitly set (even if empty) so we can
  // distinguish from missing data
  store.orgs_explicitly_set = true;
  writeStore(store);
  _cache = store;
  return true;
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
  setLicenseToken,
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

#!/usr/bin/env node
/**
 * Core logging library for the SkillMeter Codex plugin.
 *
 * Each hook script delegates to runHook(), which appends a structured NDJSON
 * record to the per-plugin log file. Stop / SubagentStop flush the batch to
 * the SkillBench ingest endpoint via gzip + POST.
 *
 * The on-wire NDJSON envelope is intentionally the same shape the Claude Code
 * plugin emits, so the backend collector lambda can accept both feeds.
 */

const crypto = require("crypto");
const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { sanitizeTranscript } = require("./sanitizer");
const credstore = require("./credstore");

// Codex sets PLUGIN_ROOT for plugin-bundled hooks and also exports
// CLAUDE_PLUGIN_ROOT for compatibility with existing plugin hook scripts.
const PLUGIN_ROOT =
  process.env.PLUGIN_ROOT ||
  process.env.CLAUDE_PLUGIN_ROOT ||
  path.resolve(__dirname, "..");

// PLUGIN_DATA is a writable per-plugin directory Codex provides. We keep the
// rotating event log there when available so installed plugins remain
// read-only on disk.
const PLUGIN_DATA =
  process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || PLUGIN_ROOT;

const LOG_DIR = path.join(PLUGIN_DATA, "logs");
const LOG_FILE = path.join(LOG_DIR, "events.jsonl");

// Staged transcripts awaiting upload live here. Sanitized snapshots are written
// before any network call so a failed upload can be retried from disk by the
// detached drain / retry monitor instead of being lost when the hook exits.
const TRANSCRIPTS_PENDING_DIR = path.join(LOG_DIR, "transcripts", "pending");

const AGENT_NAME = "codex";

const PLUGIN_VERSION = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"),
        "utf8"
      )
    );
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
})();

function getDeviceId() {
  return credstore.getDeviceId(LOG_DIR);
}

function getOrCreateHashSalt() {
  return credstore.getOrCreateHashSalt(LOG_DIR);
}

function getLicenseToken() {
  return credstore.getLicenseToken(LOG_DIR);
}

// ---------------------------------------------------------------------------
// Per-cwd settings
// ---------------------------------------------------------------------------

// Codex doesn't define a single per-cwd settings file. We adopt
// ${cwd}/.codex/settings.local.json under a "skillmeter" namespace so opt-in
// and repo-scope decisions are project-local and survive `git clone` policies
// chosen by the user (the file is typically gitignored or workspace-only).
const SETTINGS_RELATIVE = path.join(".codex", "settings.local.json");

function readSettingsFile(cwd) {
  try {
    const settingsPath = path.join(cwd, SETTINGS_RELATIVE);
    if (!fs.existsSync(settingsPath)) return null;
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return null;
  }
}

function getRepoScopeSettings(cwd) {
  const skillmeterSettings = readSettingsFile(cwd)?.skillmeter ?? {};
  return {
    enabled: skillmeterSettings.repoScope?.enabled === true,
    allowedGitHubOrgs: Array.isArray(skillmeterSettings.repoScope?.allowedGitHubOrgs)
      ? skillmeterSettings.repoScope.allowedGitHubOrgs
          .map((org) => String(org).trim().toLowerCase())
          .filter(Boolean)
      : [],
    includeUnapprovedRepos:
      skillmeterSettings.repoScope?.includeUnapprovedRepos === true,
  };
}

function hashHmac(str, salt) {
  if (!str || !salt) return "";
  return crypto.createHmac("sha256", salt).update(str).digest("hex").slice(0, 12);
}

function extractGitHubOrgFromRemote(remoteUrl) {
  if (!remoteUrl || typeof remoteUrl !== "string") return "";

  const trimmed = remoteUrl.trim();
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/.+?(?:\.git)?$/i);
  if (sshMatch) return sshMatch[1].toLowerCase();

  const httpsMatch = trimmed.match(
    /^(?:ssh:\/\/)?(?:git@)?github\.com[:/]([^/]+)\/.+?(?:\.git)?$/i
  );
  if (httpsMatch) return httpsMatch[1].toLowerCase();

  try {
    const normalized = trimmed.startsWith("http")
      ? trimmed
      : trimmed.replace(/^ssh:\/\//i, "https://");
    const url = new URL(normalized);
    if (url.hostname.toLowerCase() !== "github.com") return "";
    return (url.pathname.split("/").filter(Boolean)[0] || "").toLowerCase();
  } catch {
    return "";
  }
}

function findGitRoot(startPath) {
  if (!startPath || typeof startPath !== "string") return "";

  let currentPath = path.resolve(startPath);
  try {
    if (!fs.statSync(currentPath).isDirectory()) {
      currentPath = path.dirname(currentPath);
    }
  } catch {
    currentPath = path.dirname(currentPath);
  }

  while (true) {
    const gitPath = path.join(currentPath, ".git");
    if (fs.existsSync(gitPath)) return currentPath;

    const parent = path.dirname(currentPath);
    if (parent === currentPath) return "";
    currentPath = parent;
  }
}

function resolveGitDir(repoRoot) {
  if (!repoRoot) return "";

  const gitPath = path.join(repoRoot, ".git");
  try {
    const stats = fs.statSync(gitPath);
    if (stats.isDirectory()) return gitPath;
    if (!stats.isFile()) return "";

    const content = fs.readFileSync(gitPath, "utf8");
    const match = content.match(/^gitdir:\s*(.+)\s*$/im);
    return match ? path.resolve(repoRoot, match[1]) : "";
  } catch {
    return "";
  }
}

function getRemoteUrlsForRepo(repoRoot) {
  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) return [];

  try {
    const configPath = path.join(gitDir, "config");
    const configContent = fs.readFileSync(configPath, "utf8");
    const urls = [];
    let inRemoteSection = false;

    for (const line of configContent.split(/\r?\n/)) {
      if (/^\s*\[remote ".+"\]\s*$/.test(line)) {
        inRemoteSection = true;
        continue;
      }
      if (/^\s*\[.+\]\s*$/.test(line)) {
        inRemoteSection = false;
        continue;
      }
      if (!inRemoteSection) continue;

      const urlMatch = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
      if (urlMatch) urls.push(urlMatch[1]);
    }

    return urls;
  } catch {
    return [];
  }
}

function getRepoScopeDecision(cwd) {
  const repoScope = getRepoScopeSettings(cwd);
  if (!repoScope.enabled) {
    return { allowed: true, scope: "unscoped", classification: "disabled" };
  }

  if (repoScope.allowedGitHubOrgs.length === 0) {
    if (repoScope.includeUnapprovedRepos) {
      return {
        allowed: true,
        scope: "include_unapproved",
        classification: "include_unapproved_repos",
      };
    }
    return {
      allowed: false,
      scope: "unknown",
      classification: "no_allowed_orgs_configured",
    };
  }

  const repoRoot = findGitRoot(cwd);
  if (!repoRoot) {
    return { allowed: false, scope: "unknown", classification: "no_repository" };
  }

  const remoteOrgs = getRemoteUrlsForRepo(repoRoot)
    .map((remoteUrl) => extractGitHubOrgFromRemote(remoteUrl))
    .filter(Boolean);

  if (remoteOrgs.length === 0) {
    return {
      allowed: false,
      scope: "unknown",
      classification: "no_github_remote",
      repoRoot,
    };
  }

  const matchingOrg = remoteOrgs.find((org) =>
    repoScope.allowedGitHubOrgs.includes(org)
  );
  if (matchingOrg) {
    return {
      allowed: true,
      scope: "approved",
      classification: "github_org_match",
      repoRoot,
      remoteOrg: matchingOrg,
    };
  }

  return {
    allowed: repoScope.includeUnapprovedRepos,
    scope: "external",
    classification: repoScope.includeUnapprovedRepos
      ? "github_org_mismatch_opt_in"
      : "github_org_mismatch",
    repoRoot,
    remoteOrg: remoteOrgs[0],
  };
}

// Codex Bash hooks expose tool_input.command; apply_patch can include path-like
// fields. We hash any value that looks like a filesystem location or raw shell
// command so the upload never contains a literal user path.
const PATH_KEYS = new Set([
  "file_path",
  "filePath",
  "path",
  "command",
  "cwd",
  "patch",
]);

function sanitizeToolData(obj, hashSalt) {
  if (!obj || typeof obj !== "object") return obj;

  const result = Array.isArray(obj) ? [] : {};
  for (const [key, val] of Object.entries(obj)) {
    if (PATH_KEYS.has(key) && typeof val === "string") {
      result[key] = hashHmac(val, hashSalt);
    } else if (val && typeof val === "object") {
      result[key] = sanitizeToolData(val, hashSalt);
    } else {
      result[key] = val;
    }
  }
  return result;
}

function getTimestamp() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Transfer configuration
// ---------------------------------------------------------------------------

// The published SkillMeter Codex plugin ships pointing at the prod collector.
// Local development overrides this per-project (e.g. to the dev tenant
// collector) without changing the shipped default — resolution order is:
//   1. SKILLMETER_BACKEND_URL env var
//   2. `skillmeter.backendUrl` in <cwd>/.codex/settings.local.json
//   3. DEFAULT_BACKEND_URL (prod)
// The Codex ingest path mirrors /logs/claude but on a sibling /logs/codex
// route. The collector lambda treats `${backendUrl}/transcript` as the
// transcript handler.
const DEFAULT_BACKEND_URL = "https://api.meter.skillbench.com/logs/codex";

// Trusted domain patterns for backend URL validation
const TRUSTED_BACKEND_PATTERNS = [
  /^https:\/\/api\.meter\.skillbench\.com\//,
  /^https:\/\/[a-z0-9-]+\.skillbench\.com\//,
  /^https:\/\/[a-z0-9-]+\.meter\.dev\//,
  /^https:\/\/[a-z0-9-]+\.meter\.dev\.skillbench\.com\//,
];

function isValidBackendUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    // Only allow https for security
    if (parsed.protocol !== "https:") return false;
    // Check against trusted patterns
    return TRUSTED_BACKEND_PATTERNS.some((pattern) => pattern.test(parsed.href));
  } catch {
    return false;
  }
}

function getBackendUrl(cwd) {
  const override = process.env.SKILLMETER_BACKEND_URL;
  if (override) {
    if (!isValidBackendUrl(override)) {
      console.error(
        `[skillmeter] SKILLMETER_BACKEND_URL rejected (untrusted domain), using default`
      );
      return DEFAULT_BACKEND_URL;
    }
    return override;
  }

  const fromSettings = readSettingsFile(cwd)?.skillmeter?.backendUrl;
  if (typeof fromSettings === "string" && fromSettings.trim()) {
    const trimmed = fromSettings.trim();
    if (!isValidBackendUrl(trimmed)) {
      console.error(
        `[skillmeter] backendUrl from settings rejected (untrusted domain), using default`
      );
      return DEFAULT_BACKEND_URL;
    }
    return trimmed;
  }

  return DEFAULT_BACKEND_URL;
}

const EVENT_TIMEOUT =
  parseInt(process.env.SKILLMETER_TIMEOUT || "10", 10) * 1000;
const TRANSCRIPT_TIMEOUT = 30_000;

// How long we keep uploaded `.sent` event logs and staged transcripts before
// the cleanup sweep deletes them. 30 days survives vacations and short outages
// while keeping disks from filling if ingest breaks for weeks.
const CLEANUP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// An active `events.jsonl` that hasn't been touched in this long is assumed to
// belong to a crashed/abandoned session (a live session writes events far more
// often) and is sealed at SessionStart so its events are recovered and drained.
const ACTIVE_LOG_STALE_MS =
  parseInt(process.env.SKILLMETER_ACTIVE_LOG_STALE_MS || "", 10) || 5 * 60 * 1000;

// Drain-once de-dupe lock: stops final-session hooks (Stop/SubagentStop/
// SessionStart) from each spawning a redundant detached drain within a short
// window. The lock is advisory and self-heals once it goes stale.
const DRAIN_ONCE_LOCK_FILE = path.join(LOG_DIR, ".drain-once.lock");
const DRAIN_ONCE_LOCK_STALE_MS = 30_000;

// Retry-monitor singleton lock: ensures at most one long-running retry daemon
// runs across concurrent Codex sessions on this machine. The daemon refreshes
// the lock mtime as a heartbeat and removes it on exit.
const RETRY_DAEMON_LOCK_FILE = path.join(LOG_DIR, ".retry-daemon.lock");
const RETRY_DAEMON_LOCK_STALE_MS =
  parseInt(process.env.SKILLMETER_RETRY_DAEMON_STALE_MS || "", 10) || 5 * 60 * 1000;

function commonHeaders(extra = {}) {
  const token = getLicenseToken();
  const headers = {
    "Content-Type": "application/x-ndjson",
    "Content-Encoding": "gzip",
    "X-Plugin-Version": PLUGIN_VERSION,
    "X-Agent": AGENT_NAME,
    ...extra,
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

function transferEventLog(logFile, backendUrl = getBackendUrl(), timeoutMs = EVENT_TIMEOUT) {
  if (!logFile || !fs.existsSync(logFile)) return Promise.resolve();

  const fileContent = fs.readFileSync(logFile);
  const compressed = zlib.gzipSync(fileContent);

  console.error(
    `[skillmeter] Transferring event log: ${path.basename(logFile)} (${compressed.length} bytes gzipped)`
  );

  return fetch(backendUrl, {
    method: "POST",
    headers: commonHeaders(),
    body: compressed,
    signal: AbortSignal.timeout(timeoutMs),
  })
    .then((res) => {
      if (res.ok) {
        console.error(
          `[skillmeter] Event log transferred: ${path.basename(logFile)}`
        );
        try {
          fs.renameSync(logFile, `${logFile}.sent`);
        } catch {}
      } else {
        console.error(
          `[skillmeter] Event log transfer failed: HTTP ${res.status}`
        );
      }
    })
    .catch((err) => {
      console.error(`[skillmeter] Event log transfer error: ${err.message}`);
    });
}

// ---------------------------------------------------------------------------
// Transcript staging + upload
//
// The filesystem is the source of truth. We sanitize the transcript and write
// it to TRANSCRIPTS_PENDING_DIR before any network call, so a failed upload
// leaves a retryable snapshot on disk for the detached drain / retry monitor.
// ---------------------------------------------------------------------------

function stageTranscriptForUpload(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  try {
    fs.mkdirSync(TRANSCRIPTS_PENDING_DIR, { recursive: true });
  } catch (err) {
    console.error(`[skillmeter] Transcript staging failed (mkdir): ${err.message}`);
    return null;
  }

  const transcriptId = path.basename(transcriptPath);
  const pendingPath = path.join(TRANSCRIPTS_PENDING_DIR, transcriptId);

  try {
    const hashSalt = getOrCreateHashSalt();
    if (!hashSalt) {
      console.error(`[skillmeter] Transcript staging failed: no hash salt`);
      return null;
    }
    const sanitized = sanitizeTranscript(transcriptPath, hashSalt);
    // Overwrite previous snapshots of the same transcript — a long session
    // re-stages on every Stop and we always want the latest lines.
    fs.writeFileSync(pendingPath, sanitized);
    return pendingPath;
  } catch (err) {
    console.error(`[skillmeter] Transcript staging failed: ${err.message}`);
    return null;
  }
}

function uploadPendingTranscript(
  pendingPath,
  deviceId,
  backendUrl = getBackendUrl(),
  timeoutMs = TRANSCRIPT_TIMEOUT
) {
  if (!pendingPath || !fs.existsSync(pendingPath)) return Promise.resolve();

  const transcriptId = path.basename(pendingPath);
  const compressed = zlib.gzipSync(fs.readFileSync(pendingPath));

  const headers = commonHeaders({
    "X-Device-ID": deviceId,
    "X-Transcript-ID": transcriptId,
  });

  console.error(
    `[skillmeter] Transferring transcript: ${transcriptId} (${compressed.length} bytes gzipped)`
  );

  return fetch(`${backendUrl}/transcript`, {
    method: "POST",
    headers,
    body: compressed,
    signal: AbortSignal.timeout(timeoutMs),
  })
    .then((res) => {
      if (res.ok) {
        console.error(`[skillmeter] Transcript transferred: ${transcriptId}`);
        try { fs.unlinkSync(pendingPath); } catch {}
      } else {
        console.error(
          `[skillmeter] Transcript transfer failed: HTTP ${res.status} — kept pending for retry`
        );
      }
    })
    .catch((err) => {
      console.error(
        `[skillmeter] Transcript transfer error: ${err.message} — kept pending for retry`
      );
    });
}

// Backwards-compatible one-shot: stage then upload. Failed uploads remain in
// the pending queue for the detached drain / retry monitor.
function transferTranscript(transcriptPath, deviceId, backendUrl = getBackendUrl()) {
  const pendingPath = stageTranscriptForUpload(transcriptPath);
  if (!pendingPath) return Promise.resolve();
  return uploadPendingTranscript(pendingPath, deviceId, backendUrl);
}

// ---------------------------------------------------------------------------
// Event-log sealing + crash recovery
// ---------------------------------------------------------------------------

/**
 * Seal the active event log into a retryable batch (`events.jsonl.<ts>`). This
 * is a local durable-queue transition only; uploading is handled separately by
 * the drain functions. Returns the sealed path, or null when there was nothing
 * to seal.
 */
function sealEventLog() {
  if (!fs.existsSync(LOG_FILE)) {
    console.error(`[skillmeter] No event log to seal`);
    return null;
  }

  const baseTimestamp = Date.now();
  for (let attempt = 0; attempt < 100; attempt++) {
    const sealedFile = `${LOG_FILE}.${baseTimestamp + attempt}`;
    if (fs.existsSync(sealedFile)) continue;
    try {
      fs.renameSync(LOG_FILE, sealedFile);
      console.error(`[skillmeter] Sealed event log: ${path.basename(sealedFile)}`);
      return sealedFile;
    } catch (err) {
      if (err && err.code === "ENOENT") {
        console.error(`[skillmeter] No event log to seal`);
        return null;
      }
      if (err && err.code === "EEXIST") continue;
      console.error(`[skillmeter] Event log seal failed: ${err.message}`);
      return null;
    }
  }
  console.error(`[skillmeter] Event log seal failed: no unique batch name`);
  return null;
}

/**
 * Recover an un-rotated `events.jsonl` left behind by a crashed/abandoned
 * session. A live session writes events frequently, so an active log that has
 * been idle beyond ACTIVE_LOG_STALE_MS is assumed orphaned and is sealed so its
 * events join the drain queue. Sealing only splits the stream — it never
 * duplicates events — so an over-eager seal of a quiet-but-live session is
 * harmless. Returns the sealed path, or null.
 */
function recoverStaleActiveLog() {
  let st;
  try {
    st = fs.statSync(LOG_FILE);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;

  const age = Date.now() - st.mtimeMs;
  if (age < ACTIVE_LOG_STALE_MS) return null;

  console.error(
    `[skillmeter] Recovering un-rotated event log (idle ${Math.round(age / 1000)}s) from a prior session`
  );
  return sealEventLog();
}

// Backwards-compatible flush: seal the active log and upload it immediately.
function flushEventLog(backendUrl = getBackendUrl()) {
  const sealed = sealEventLog();
  if (!sealed) return Promise.resolve();
  return transferEventLog(sealed, backendUrl);
}

// ---------------------------------------------------------------------------
// Durable-queue listing + draining
// ---------------------------------------------------------------------------

function listSealedEventLogs() {
  if (!fs.existsSync(LOG_DIR)) return [];
  try {
    return fs.readdirSync(LOG_DIR)
      .filter((file) => /^events\.jsonl\.\d+$/.test(file))
      .map((file) => path.join(LOG_DIR, file))
      .filter((filePath) => {
        try { return fs.statSync(filePath).isFile(); } catch { return false; }
      });
  } catch {
    return [];
  }
}

function listPendingTranscripts() {
  if (!fs.existsSync(TRANSCRIPTS_PENDING_DIR)) return [];
  try {
    return fs.readdirSync(TRANSCRIPTS_PENDING_DIR)
      .map((file) => path.join(TRANSCRIPTS_PENDING_DIR, file))
      .filter((filePath) => {
        try { return fs.statSync(filePath).isFile(); } catch { return false; }
      });
  } catch {
    return [];
  }
}

async function drainFailedLogs(backendUrl = getBackendUrl(process.cwd()), timeoutMs) {
  const files = listSealedEventLogs();
  if (files.length === 0) return 0;
  console.error(`[skillmeter] Draining ${files.length} sealed event log(s)`);
  await Promise.allSettled(
    files.map((filePath) => transferEventLog(filePath, backendUrl, timeoutMs))
  );
  return files.length;
}

async function drainPendingTranscripts(backendUrl = getBackendUrl(process.cwd()), timeoutMs) {
  const files = listPendingTranscripts();
  if (files.length === 0) return 0;

  const deviceId = getDeviceId();
  if (!deviceId) return 0;

  console.error(`[skillmeter] Draining ${files.length} pending transcript(s)`);
  await Promise.allSettled(
    files.map((filePath) => uploadPendingTranscript(filePath, deviceId, backendUrl, timeoutMs))
  );
  return files.length;
}

/**
 * Drain both durable queues once. Returns the number of queued items found
 * (pre-drain), which callers use to decide whether work remains.
 */
async function drainQueuesOnce(backendUrl = getBackendUrl(process.cwd()), timeoutMs) {
  const logs = await drainFailedLogs(backendUrl, timeoutMs);
  const transcripts = await drainPendingTranscripts(backendUrl, timeoutMs);
  return logs + transcripts;
}

// Backwards-compatible alias retained for existing callers/tests.
function retryFailedLogs(backendUrl = getBackendUrl(process.cwd())) {
  void drainFailedLogs(backendUrl);
}

// ---------------------------------------------------------------------------
// Detached drain spawn (one-shot)
// ---------------------------------------------------------------------------

function shouldSpawnDrainOnce() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const st = fs.statSync(DRAIN_ONCE_LOCK_FILE);
    if (Date.now() - st.mtimeMs < DRAIN_ONCE_LOCK_STALE_MS) {
      console.error(`[skillmeter] Drain trigger skipped: recent drain already requested`);
      return false;
    }
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      console.error(`[skillmeter] Drain lock check failed: ${err.message}`);
    }
  }

  try {
    fs.writeFileSync(DRAIN_ONCE_LOCK_FILE, `${process.pid} ${Date.now()}\n`);
    return true;
  } catch (err) {
    console.error(`[skillmeter] Drain lock write failed: ${err.message}`);
    return false;
  }
}

function clearDrainOnceLock() {
  try { fs.unlinkSync(DRAIN_ONCE_LOCK_FILE); } catch {}
}

/**
 * Spawn a detached one-shot drain so the hook returns without waiting on
 * network I/O. The resolved backend URL is passed through the environment so
 * the child doesn't depend on re-reading per-cwd settings.
 */
function spawnDetachedDrain() {
  if (!shouldSpawnDrainOnce()) return false;

  const script = path.join(PLUGIN_ROOT, "scripts", "drain_once.js");
  try {
    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, SKILLMETER_BACKEND_URL: getBackendUrl(process.cwd()) },
    });
    child.unref();
    console.error(`[skillmeter] Drain trigger spawned: pid=${child.pid}`);
    return true;
  } catch (err) {
    clearDrainOnceLock();
    console.error(`[skillmeter] Drain trigger spawn failed: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Retry monitor (long-running, self-spawned singleton)
//
// Codex has no managed monitor lifecycle (unlike Claude Code), so we launch the
// retry daemon detached from SessionStart and rely on a heartbeat lock to keep
// it a singleton across concurrent sessions. The daemon self-terminates on
// idle / max-lifetime so it never orphans.
// ---------------------------------------------------------------------------

function isProcessAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

function readRetryDaemonLock() {
  try {
    const raw = fs.readFileSync(RETRY_DAEMON_LOCK_FILE, "utf8").trim();
    const pid = parseInt(raw.split(/\s+/)[0], 10);
    const st = fs.statSync(RETRY_DAEMON_LOCK_FILE);
    return { pid, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function isRetryDaemonRunning() {
  const lock = readRetryDaemonLock();
  if (!lock) return false;
  if (Date.now() - lock.mtimeMs > RETRY_DAEMON_LOCK_STALE_MS) return false;
  return isProcessAlive(lock.pid);
}

function writeRetryDaemonLock(pid) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(RETRY_DAEMON_LOCK_FILE, `${pid} ${Date.now()}\n`);
    return true;
  } catch {
    return false;
  }
}

function refreshRetryDaemonLock(pid = process.pid) {
  return writeRetryDaemonLock(pid);
}

function ownsRetryDaemonLock(pid = process.pid) {
  const lock = readRetryDaemonLock();
  return !!lock && lock.pid === pid;
}

function clearRetryDaemonLock(pid = process.pid) {
  if (!ownsRetryDaemonLock(pid)) return;
  try { fs.unlinkSync(RETRY_DAEMON_LOCK_FILE); } catch {}
}

/**
 * Launch the long-running retry monitor if one isn't already running. Returns
 * true when a new daemon was spawned.
 */
function spawnRetryDaemon() {
  if (isRetryDaemonRunning()) {
    console.error(`[skillmeter] Retry monitor already running`);
    return false;
  }

  const script = path.join(PLUGIN_ROOT, "scripts", "monitors", "retry_daemon.js");
  try {
    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, SKILLMETER_BACKEND_URL: getBackendUrl(process.cwd()) },
    });
    // Claim the lock immediately so a concurrent SessionStart doesn't also
    // spawn one; the daemon refreshes this heartbeat as it runs.
    writeRetryDaemonLock(child.pid);
    child.unref();
    console.error(`[skillmeter] Retry monitor spawned: pid=${child.pid}`);
    return true;
  } catch (err) {
    console.error(`[skillmeter] Retry monitor spawn failed: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cleanup + final-session sealing
// ---------------------------------------------------------------------------

/**
 * Delete uploaded `.sent` event logs and staged transcripts older than
 * CLEANUP_MAX_AGE_MS so nothing accumulates forever once it has been uploaded
 * (or has aged out as undeliverable).
 */
function cleanupStaleFiles() {
  const now = Date.now();
  const candidates = [];

  if (fs.existsSync(LOG_DIR)) {
    try {
      for (const f of fs.readdirSync(LOG_DIR)) {
        if (/^events\.jsonl\.\d+\.sent$/.test(f)) {
          candidates.push(path.join(LOG_DIR, f));
        }
      }
    } catch {}
  }

  if (fs.existsSync(TRANSCRIPTS_PENDING_DIR)) {
    try {
      for (const f of fs.readdirSync(TRANSCRIPTS_PENDING_DIR)) {
        candidates.push(path.join(TRANSCRIPTS_PENDING_DIR, f));
      }
    } catch {}
  }

  let deleted = 0;
  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      if (st.isFile() && now - st.mtimeMs > CLEANUP_MAX_AGE_MS) {
        fs.unlinkSync(p);
        deleted++;
      }
    } catch {}
  }

  if (deleted > 0) {
    console.error(`[skillmeter] Cleaned up ${deleted} stale file(s) older than 30 days`);
  }
}

/**
 * Seal final-session artifacts into durable queues and kick off a detached
 * drain. Uploading is left to the drain / retry monitor so the hook returns
 * quickly instead of blocking on network I/O.
 */
function sealFinalSessionArtifacts(input) {
  const sealed = sealEventLog();

  let staged = null;
  if (input && input.transcript_path && fs.existsSync(input.transcript_path)) {
    staged = stageTranscriptForUpload(input.transcript_path);
  } else if (input && input.agent_transcript_path && fs.existsSync(input.agent_transcript_path)) {
    staged = stageTranscriptForUpload(input.agent_transcript_path);
  } else {
    console.error(`[skillmeter] No transcript to stage`);
  }

  if (sealed || staged) spawnDetachedDrain();
}

function sealEventLogAndTriggerDrain() {
  if (sealEventLog()) spawnDetachedDrain();
}

// Replaces the old synchronous flush+upload: seal locally, then hand off to a
// detached drain so the Stop / SubagentStop hook isn't blocked on the network.
function flushAndTransfer(input) {
  sealFinalSessionArtifacts(input);
  return Promise.resolve();
}

function logStructured(level, event, sessionId, data, deviceId) {
  if (!deviceId) return;

  fs.mkdirSync(LOG_DIR, { recursive: true });

  const logEntry = {
    timestamp: getTimestamp(),
    level,
    hook_event_name: event,
    session_id: sessionId,
    device_id: deviceId,
    agent: AGENT_NAME,
    data,
  };

  fs.appendFileSync(LOG_FILE, JSON.stringify(logEntry) + "\n");
}

function getTranscriptId(transcriptPath) {
  if (!transcriptPath) return "";
  return path.basename(transcriptPath);
}

const logInfo = (event, sessionId, data, deviceId) =>
  logStructured("info", event, sessionId, data, deviceId);

function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }

    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : null);
      } catch (e) {
        reject(e);
      }
    });
    process.stdin.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Telemetry opt-in management
// ---------------------------------------------------------------------------

function getTelemetryOptIn(cwd) {
  try {
    const content = readSettingsFile(cwd);
    if (!content) return null;
    if (!content.skillmeter || typeof content.skillmeter.telemetry !== "boolean") return null;
    return content.skillmeter.telemetry;
  } catch {
    return null;
  }
}

function saveTelemetryOptIn(cwd, value) {
  const settingsPath = path.join(cwd, SETTINGS_RELATIVE);
  let content = {};
  try {
    if (fs.existsSync(settingsPath)) {
      content = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    }
  } catch {
    content = {};
  }
  content.skillmeter = { ...content.skillmeter, telemetry: value };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(content, null, 2) + "\n");
}

function promptTelemetryOptIn(cwd) {
  // Codex hooks run with the session cwd as their working directory but
  // typically without a controlling TTY, so an osascript dialog is the only
  // reliable way to surface a consent prompt on macOS. On other platforms we
  // default to "not yet decided" so the user can opt in via `node telemetry.js
  // enable`.
  if (process.platform !== "darwin") return false;
  try {
    const result = execSync(
      `osascript -e 'display dialog "Enable SkillMeter telemetry for this Codex project?\\n\\nTelemetry helps improve SkillMeter by collecting anonymous usage data." with title "SkillMeter" buttons {"No", "Yes"} default button "Yes"'`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 }
    );
    const enabled = result.trim().includes("button returned:Yes");
    saveTelemetryOptIn(cwd, enabled);
    return enabled;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// runHook — shared driver for every Codex hook script
// ---------------------------------------------------------------------------

/**
 * Common runtime for hook scripts.
 *
 * @param {string} eventName - Codex hook event name
 * @param {function} buildData - (input, ctx) => event-specific data
 * @param {object} [options]
 * @param {function} [options.beforeStdin] - Called after device id resolves, before stdin
 * @param {function} [options.checkOptIn] - Custom opt-in: (cwd, input) => bool
 * @param {function} [options.afterSkip] - Hook for repo-scope-rejected case
 * @param {function} [options.afterLog] - Called after logInfo (e.g. flush)
 * @param {boolean} [options.requireJsonStdout] - If true, write `{}` to stdout
 *   before any exit. Required by Codex for Stop and SubagentStop.
 */
async function runHook(eventName, buildData, options = {}) {
  const requireJsonStdout = !!options.requireJsonStdout;
  const exit = (code) => {
    if (requireJsonStdout) {
      try { process.stdout.write("{}\n"); } catch {}
    }
    process.exit(code);
  };

  const deviceId = getDeviceId();
  if (!deviceId) {
    console.error(`[skillmeter] ${eventName}: skipped (no device ID)`);
    return exit(0);
  }

  if (options.beforeStdin) options.beforeStdin(deviceId);

  let input;
  try {
    input = await readStdin();
  } catch (err) {
    console.error(`[skillmeter] ${eventName}: stdin parse failed (${err.message})`);
    return exit(0);
  }
  if (!input) {
    console.error(`[skillmeter] ${eventName}: skipped (no stdin input)`);
    return exit(0);
  }

  const cwd = input.cwd || process.cwd();

  if (options.checkOptIn) {
    if (!options.checkOptIn(cwd, input)) return exit(0);
  } else {
    if (getTelemetryOptIn(cwd) !== true) {
      console.error(`[skillmeter] ${eventName}: skipped (telemetry not enabled)`);
      return exit(0);
    }
  }

  const sessionId = input.session_id || "unknown";
  const hashSalt = getOrCreateHashSalt();
  if (!hashSalt) {
    console.error(`[skillmeter] ${eventName}: skipped (no hash salt)`);
    return exit(0);
  }

  const repoScopeDecision = getRepoScopeDecision(cwd);
  if (!repoScopeDecision.allowed) {
    console.error(
      `[skillmeter] ${eventName}: skipped (${repoScopeDecision.classification})`
    );
    if (options.afterSkip) {
      const result = options.afterSkip(input, deviceId);
      if (result && typeof result.then === "function") {
        await result;
      }
    }
    return exit(0);
  }

  const ctx = { hashSalt, cwd, sanitizeToolData, getTranscriptId };
  const eventData = buildData ? buildData(input, ctx) : {};

  const data = {
    transcript_path: getTranscriptId(input.transcript_path),
    cwd: hashHmac(cwd, hashSalt),
    repo_scope: repoScopeDecision.scope,
    repo_classification: repoScopeDecision.classification,
    repo_root: repoScopeDecision.repoRoot
      ? hashHmac(repoScopeDecision.repoRoot, hashSalt)
      : undefined,
    repo_remote_org: repoScopeDecision.remoteOrg
      ? hashHmac(repoScopeDecision.remoteOrg, hashSalt)
      : undefined,
    permission_mode: input.permission_mode,
    model: input.model,
    turn_id: input.turn_id,
    ...eventData,
  };

  logInfo(eventName, sessionId, data, deviceId);
  console.error(
    `[skillmeter] ${eventName}: logged (session=${String(sessionId).slice(0, 8)}…)`
  );

  if (options.afterLog) {
    const result = options.afterLog(input, deviceId);
    if (result && typeof result.then === "function") {
      await result;
    }
  }

  return exit(0);
}

module.exports = {
  getDeviceId,
  getOrCreateHashSalt,
  getLicenseToken,
  hashHmac,
  sanitizeToolData,
  getTimestamp,
  logStructured,
  logInfo,
  readStdin,
  getTranscriptId,
  retryFailedLogs,
  transferEventLog,
  transferTranscript,
  flushEventLog,
  flushAndTransfer,
  // Durable queue: sealing + crash recovery
  sealEventLog,
  recoverStaleActiveLog,
  sealFinalSessionArtifacts,
  sealEventLogAndTriggerDrain,
  // Durable queue: transcript staging
  stageTranscriptForUpload,
  uploadPendingTranscript,
  // Durable queue: listing + draining
  listSealedEventLogs,
  listPendingTranscripts,
  drainFailedLogs,
  drainPendingTranscripts,
  drainQueuesOnce,
  // Detached drain (one-shot)
  shouldSpawnDrainOnce,
  clearDrainOnceLock,
  spawnDetachedDrain,
  // Retry monitor (long-running singleton)
  isRetryDaemonRunning,
  spawnRetryDaemon,
  refreshRetryDaemonLock,
  ownsRetryDaemonLock,
  clearRetryDaemonLock,
  // Cleanup
  cleanupStaleFiles,
  getTelemetryOptIn,
  saveTelemetryOptIn,
  promptTelemetryOptIn,
  getRepoScopeSettings,
  getRepoScopeDecision,
  runHook,
  PLUGIN_ROOT,
  PLUGIN_DATA,
  PLUGIN_VERSION,
  LOG_DIR,
  LOG_FILE,
  TRANSCRIPTS_PENDING_DIR,
  CLEANUP_MAX_AGE_MS,
  ACTIVE_LOG_STALE_MS,
  DRAIN_ONCE_LOCK_FILE,
  RETRY_DAEMON_LOCK_FILE,
  DEFAULT_BACKEND_URL,
  getBackendUrl,
  AGENT_NAME,
  SETTINGS_RELATIVE,
};

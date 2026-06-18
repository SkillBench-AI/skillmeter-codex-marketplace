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
const { getEndpointFromToken, isJwtExpired } = require("./lib/jwt");
const { trySilentGhActivate, refreshExpiredJwt } = require("./lib/license-activation");

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
// License refresh
//
// Try the Lambda's /refresh endpoint first (no GitHub round-trip, works for
// users without gh-cli), then fall back to the silent gh /activate path on
// 410 / 404 / network failure. Called once per SessionStart so the hook
// architecture itself rate-limits it to at-most-once-per-session. Best effort:
// every failure returns null and the session continues unauthenticated, leaving
// the on-disk queue for the next refreshed session to drain.
// ---------------------------------------------------------------------------

async function tryRefreshLicense(deviceId) {
  const current = getLicenseToken();
  if (current && !credstore.isLicenseTokenExpired(current)) {
    return current;
  }
  if (!deviceId) return null;
  if (credstore.getSignedOut()) return null;

  // /refresh first when we have a token to rotate. refreshExpiredJwt returns
  // null on 410 (sliding window), 404 (endpoint not deployed), 401 (bad
  // signature), or any network/parse error — falling through to gh in all cases.
  if (current) {
    const fresh = await refreshExpiredJwt(current, deviceId);
    if (fresh) return fresh;
  }

  try {
    return await trySilentGhActivate(deviceId);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-cwd settings
// ---------------------------------------------------------------------------

// Codex doesn't define a single per-cwd settings file. We adopt
// ${cwd}/.codex/settings.local.json under a "skillmeter" namespace so the
// per-project opt-in (and dev backend/activation overrides) are project-local
// and survive `git clone` policies chosen by the user (the file is typically
// gitignored or workspace-only). Repo-scope is NOT configured here — it derives
// from the signed-in user's GitHub identities (see getRepoScopeDecision).
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

// Decide whether an event from `cwd` is in-scope. Telemetry fires only in
// repos whose GitHub remote belongs to the signed-in user's own login or one
// of their org memberships, captured from `GET /user` + `GET /user/orgs` at
// signin and stored in ~/.skillbench/credentials.json. This matches the Claude
// plugin exactly: with no signed-in orgs the result is `not_activated` and
// everything is dropped — there is no permissive "unscoped"/allow-all default
// and no per-project allow-list. Non-git directories, non-GitHub remotes, and
// repos outside the allowed orgs are all blocked.
function getRepoScopeDecision(cwd) {
  const allowedOrgs = credstore.getAllowedGitHubOrgs();
  if (allowedOrgs.length === 0) {
    return { allowed: false, scope: "unknown", classification: "not_activated" };
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

  const matchingOrg = remoteOrgs.find((org) => allowedOrgs.includes(org));
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
    allowed: false,
    scope: "external",
    classification: "github_org_mismatch",
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

// The Codex ingest path mirrors /logs/claude but on a sibling /logs/codex
// route. The collector lambda treats `${backendUrl}/transcript` as the
// transcript handler.
const INGEST_ROUTE = "/logs/codex";

// The published SkillMeter Codex plugin ships pointing at the prod collector.
// The ingest endpoint is resolved at upload time in this order:
//   1. SKILLMETER_BACKEND_URL env var (full ingest URL; dev/test bypass)
//   2. `skillmeter.backendUrl` in <cwd>/.codex/settings.local.json (full URL)
//   3. JWT-derived per-tenant endpoint: the `telemetry_endpoint` claim of a
//      valid license JWT, with the /logs/codex route appended. This is what
//      routes each tenant's traffic to its own meter host without per-tenant
//      plugin builds (matching the Claude plugin).
//   4. DEFAULT_BACKEND_URL (prod) — fallback when unauthenticated or the JWT
//      carries no endpoint.
// Env/settings overrides (1, 2) are user-supplied so they're validated against
// the trusted-domain allow-list; the JWT endpoint (3) is server-minted and
// trusted as-is (see lib/jwt.js).
const DEFAULT_BACKEND_URL = "https://api.meter.skillbench.com/logs/codex";

// Trusted domain patterns for backend URL validation
const TRUSTED_BACKEND_PATTERNS = [
  /^https:\/\/api\.meter\.skillbench\.com\//,
  /^https:\/\/[a-z0-9-]+\.meter\.skillbench\.com\//,
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

  // Per-tenant routing: a signed-in user's license JWT carries the tenant's
  // meter host in its `telemetry_endpoint` claim. Resolve it (skips an expired
  // token) and append the Codex ingest route. Falls through to the prod default
  // when there's no usable token, preserving the unauthenticated upload path.
  const endpoint = getEndpointFromToken(getLicenseToken());
  if (endpoint) {
    const fullUrl = `${endpoint}${INGEST_ROUTE}`;
    if (!isValidBackendUrl(fullUrl)) {
      console.error(
        `[skillmeter] JWT-derived endpoint rejected (untrusted domain), using default`
      );
      return DEFAULT_BACKEND_URL;
    }
    return fullUrl;
  }

  return DEFAULT_BACKEND_URL;
}

const EVENT_TIMEOUT =
  parseInt(process.env.SKILLMETER_TIMEOUT || "10", 10) * 1000;
const TRANSCRIPT_TIMEOUT = 30_000;

// How long we keep uploaded `.sent` event logs, quarantined poison batches, and
// staged transcripts before the cleanup sweep deletes them. 30 days survives
// vacations and short outages while keeping disks from filling if ingest breaks
// for weeks.
const CLEANUP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Poison-batch / retry bounds
//
// A "poison batch" is a sealed event log the backend will never accept —
// usually because the payload is malformed (HTTP 400/413/422). Retrying it
// forever wastes bandwidth and keeps the queue from ever draining, so failed
// batches are bounded two ways and then quarantined (moved aside, not deleted)
// so they stop being retried but remain available for forensics until the
// 30-day cleanup removes them:
//
//   - max-retry: a batch that keeps failing transiently is quarantined after
//     MAX_BATCH_RETRIES attempts (tracked in a `.meta` sidecar).
//   - max-age:   a batch we've been unable to deliver for longer than
//     BATCH_MAX_AGE_MS (derived from the seal timestamp in its filename) is
//     treated as undeliverable and quarantined regardless of attempt count.
//
// Permanent HTTP errors short-circuit both bounds: we try a partial-rejection
// salvage (drop only the invalid NDJSON lines) once, then quarantine.
// ---------------------------------------------------------------------------
const POISON_DIR = path.join(LOG_DIR, "poison");

const MAX_BATCH_RETRIES =
  parseInt(process.env.SKILLMETER_MAX_BATCH_RETRIES || "", 10) || 25;

const BATCH_MAX_AGE_MS =
  parseInt(process.env.SKILLMETER_BATCH_MAX_AGE_MS || "", 10) ||
  14 * 24 * 60 * 60 * 1000;

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

// Build the shared upload headers. The license JWT is passed explicitly (not
// read here) so callers can decide whether to attach it — they drop an expired
// token proactively and retry without auth after a 401/403.
function commonHeaders(token, extra = {}) {
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

// ---------------------------------------------------------------------------
// Atomic write helpers
//
// Hooks from concurrent Codex processes can write to the queue at the same
// time, and a process can be killed mid-write. Both can leave interleaved or
// half-written ("invalid") lines that later poison an upload. These helpers
// keep on-disk artifacts line-atomic and whole-file-atomic respectively.
// ---------------------------------------------------------------------------

// Append a single newline-terminated record in one O_APPEND write. POSIX makes
// each write() to an append-mode fd advance the offset atomically, so a single
// write of the whole record can't interleave with another writer's record —
// preventing the spliced lines that would make a batch un-parseable.
function atomicAppendLine(file, line) {
  const buf = Buffer.from(line.endsWith("\n") ? line : `${line}\n`);
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, buf, 0, buf.length, null);
  } finally {
    fs.closeSync(fd);
  }
}

// Write a whole file by staging to a unique temp path and renaming into place.
// rename(2) is atomic within a filesystem, so readers/drains never observe a
// partially written file — they see either the old contents or the new ones.
function atomicWriteFileSync(targetPath, data) {
  const dir = path.dirname(targetPath);
  const tmp = path.join(
    dir,
    `.${path.basename(targetPath)}.tmp-${process.pid}-${crypto
      .randomBytes(4)
      .toString("hex")}`
  );
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

// ---------------------------------------------------------------------------
// HTTP outcome classification
//
// 401/403 are handled separately (clear the token + retry without auth). Of the
// remaining non-2xx responses we treat 408 (Request Timeout), 429 (Too Many
// Requests), and every 5xx as transient (worth retrying) and any other 4xx as
// permanent — the server is telling us this exact payload will never be
// accepted, so it must not be retried forever.
// ---------------------------------------------------------------------------
function isPermanentHttpStatus(status) {
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

// Upload one sealed event log. Resolves to an outcome the queue layer acts on:
//   "sent"   — 2xx; the file was renamed to `.sent`.
//   "poison" — permanent server rejection; the payload will never be accepted.
//   "retry"  — transient failure (5xx / 408 / 429 / network / timeout).
//   "skip"   — nothing to do (missing file).
// Standalone callers can ignore the value; processSealedBatch uses it to decide
// between salvage, quarantine, and a bounded retry.
function transferEventLog(logFile, backendUrl = getBackendUrl(), timeoutMs = EVENT_TIMEOUT) {
  if (!logFile || !fs.existsSync(logFile)) return Promise.resolve("skip");

  const storedToken = getLicenseToken();
  // Proactive: never send a JWT we already know is past its exp. The ingest
  // endpoint accepts unauthenticated batches, so dropping the token still lets
  // the upload through and the next session's refresh re-authenticates.
  const initialToken = storedToken && !isJwtExpired(storedToken) ? storedToken : null;
  if (storedToken && !initialToken) {
    console.error(`[skillmeter] Event log: dropping expired license JWT before send`);
  }

  const compressed = zlib.gzipSync(fs.readFileSync(logFile));
  const baseName = path.basename(logFile);

  const doPost = (token) =>
    fetch(backendUrl, {
      method: "POST",
      headers: commonHeaders(token),
      body: compressed,
      signal: AbortSignal.timeout(timeoutMs),
    });

  const markSent = () => {
    try { fs.renameSync(logFile, `${logFile}.sent`); } catch {}
  };

  const classify = (status) =>
    isPermanentHttpStatus(status) ? "poison" : "retry";

  console.error(
    `[skillmeter] Transferring event log: ${baseName} (${compressed.length} bytes gzipped)`
  );

  return doPost(initialToken)
    .then((res) => {
      if (res.ok) {
        console.error(`[skillmeter] Event log transferred: ${baseName}`);
        markSent();
        return "sent";
      }
      // Reactive: the server rejected our Authorization header — clear the bad
      // token so later requests don't reuse it, then retry once without auth.
      if (initialToken && (res.status === 401 || res.status === 403)) {
        console.error(
          `[skillmeter] Event log auth rejected (HTTP ${res.status}), clearing license and retrying without auth`
        );
        try { credstore.setLicenseToken(""); } catch {}
        return doPost(null).then((res2) => {
          if (res2.ok) {
            console.error(`[skillmeter] Event log transferred on retry: ${baseName}`);
            markSent();
            return "sent";
          }
          console.error(`[skillmeter] Event log retry failed: HTTP ${res2.status}`);
          return classify(res2.status);
        });
      }
      console.error(`[skillmeter] Event log transfer failed: HTTP ${res.status}`);
      return classify(res.status);
    })
    .catch((err) => {
      console.error(`[skillmeter] Event log transfer error: ${err.message}`);
      return "retry";
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
    // re-stages on every Stop and we always want the latest lines. Write
    // atomically so a crash mid-stage can't leave a truncated transcript that a
    // concurrent drain would then upload (and the server reject) as poison.
    atomicWriteFileSync(pendingPath, sanitized);
    return pendingPath;
  } catch (err) {
    console.error(`[skillmeter] Transcript staging failed: ${err.message}`);
    return null;
  }
}

// Upload one staged transcript. Resolves to the same outcome vocabulary as
// transferEventLog ("sent" / "poison" / "retry" / "skip"); on 2xx the pending
// file is removed. processPendingTranscript uses the outcome to quarantine
// permanently-rejected transcripts instead of retrying them indefinitely.
function uploadPendingTranscript(
  pendingPath,
  deviceId,
  backendUrl = getBackendUrl(),
  timeoutMs = TRANSCRIPT_TIMEOUT
) {
  if (!pendingPath || !fs.existsSync(pendingPath)) return Promise.resolve("skip");

  const storedToken = getLicenseToken();
  const initialToken = storedToken && !isJwtExpired(storedToken) ? storedToken : null;
  if (storedToken && !initialToken) {
    console.error(`[skillmeter] Transcript: dropping expired license JWT before send`);
  }

  const transcriptId = path.basename(pendingPath);
  const compressed = zlib.gzipSync(fs.readFileSync(pendingPath));

  const doPost = (token) =>
    fetch(`${backendUrl}/transcript`, {
      method: "POST",
      headers: commonHeaders(token, {
        "X-Device-ID": deviceId,
        "X-Transcript-ID": transcriptId,
      }),
      body: compressed,
      signal: AbortSignal.timeout(timeoutMs),
    });

  const removePending = () => {
    try { fs.unlinkSync(pendingPath); } catch {}
  };

  const classify = (status) =>
    isPermanentHttpStatus(status) ? "poison" : "retry";

  console.error(
    `[skillmeter] Transferring transcript: ${transcriptId} (${compressed.length} bytes gzipped)`
  );

  return doPost(initialToken)
    .then((res) => {
      if (res.ok) {
        console.error(`[skillmeter] Transcript transferred: ${transcriptId}`);
        removePending();
        return "sent";
      }
      if (initialToken && (res.status === 401 || res.status === 403)) {
        console.error(
          `[skillmeter] Transcript auth rejected (HTTP ${res.status}), clearing license and retrying without auth`
        );
        try { credstore.setLicenseToken(""); } catch {}
        return doPost(null).then((res2) => {
          if (res2.ok) {
            console.error(`[skillmeter] Transcript transferred on retry: ${transcriptId}`);
            removePending();
            return "sent";
          }
          console.error(
            `[skillmeter] Transcript retry failed: HTTP ${res2.status} — kept pending for retry`
          );
          return classify(res2.status);
        });
      }
      console.error(
        `[skillmeter] Transcript transfer failed: HTTP ${res.status} — kept pending for retry`
      );
      return classify(res.status);
    })
    .catch((err) => {
      console.error(
        `[skillmeter] Transcript transfer error: ${err.message} — kept pending for retry`
      );
      return "retry";
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
      // Skip in-flight atomic-write temp files (.<name>.tmp-…) and meta
      // sidecars so a concurrent drain never tries to upload a half-written
      // snapshot.
      .filter((file) => !file.startsWith("."))
      .map((file) => path.join(TRANSCRIPTS_PENDING_DIR, file))
      .filter((filePath) => {
        try { return fs.statSync(filePath).isFile(); } catch { return false; }
      });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Poison-batch handling: attempt tracking, partial-rejection salvage, quarantine
// ---------------------------------------------------------------------------

// Per-batch attempt counter. Kept in a `.meta` sidecar rather than the filename
// so the batch path (and the drain-list regex) stays stable across retries.
function batchMetaPath(batchPath) {
  return `${batchPath}.meta`;
}

function readBatchMeta(batchPath) {
  try {
    const meta = JSON.parse(fs.readFileSync(batchMetaPath(batchPath), "utf8"));
    return { attempts: Number(meta.attempts) || 0 };
  } catch {
    return { attempts: 0 };
  }
}

function writeBatchMeta(batchPath, meta) {
  try {
    atomicWriteFileSync(batchMetaPath(batchPath), JSON.stringify(meta) + "\n");
  } catch {}
}

function clearBatchMeta(batchPath) {
  try { fs.unlinkSync(batchMetaPath(batchPath)); } catch {}
}

// Seal timestamp encoded in `events.jsonl.<ts>` — used as the batch's
// first-seen time for the max-age give-up. Returns null for unexpected names.
function batchSealTimeMs(batchPath) {
  const m = path.basename(batchPath).match(/^events\.jsonl\.(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

// Move an undeliverable file aside into POISON_DIR so it stops being retried
// but survives for forensics until the 30-day cleanup removes it. Deletion is a
// last resort only if the move fails (e.g. cross-device) so a poison batch can
// never wedge the queue.
function quarantineFile(filePath, reason) {
  const baseName = path.basename(filePath);
  try {
    fs.mkdirSync(POISON_DIR, { recursive: true });
    const dest = path.join(POISON_DIR, baseName);
    try { fs.unlinkSync(dest); } catch {}
    fs.renameSync(filePath, dest);
    console.error(`[skillmeter] Quarantined poison batch ${baseName}: ${reason}`);
  } catch (err) {
    console.error(
      `[skillmeter] Quarantine of ${baseName} failed (${err.message}); deleting to unblock queue`
    );
    try { fs.unlinkSync(filePath); } catch {}
  }
}

// Partial batch rejection: an NDJSON batch can be poisoned by a few malformed
// lines (e.g. a half-written record from a crashed writer). Re-parse line by
// line, keep only the valid JSON records, and rewrite the batch atomically when
// — and only when — some lines were actually invalid. Returns a summary the
// caller uses to decide whether a salvage retry is worthwhile.
function salvageBatch(batchPath) {
  let raw;
  try {
    raw = fs.readFileSync(batchPath, "utf8");
  } catch {
    return { rewrote: false, kept: 0, dropped: 0 };
  }

  const valid = [];
  let dropped = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
      valid.push(line);
    } catch {
      dropped++;
    }
  }

  // Every line is well-formed JSON, so the rejection isn't about parse-ability
  // — there's nothing to salvage and the batch is genuinely poison.
  if (dropped === 0) return { rewrote: false, kept: valid.length, dropped: 0 };
  // Nothing salvageable; let the caller quarantine the whole batch.
  if (valid.length === 0) return { rewrote: false, kept: 0, dropped };

  try {
    atomicWriteFileSync(batchPath, valid.join("\n") + "\n");
    return { rewrote: true, kept: valid.length, dropped };
  } catch {
    return { rewrote: false, kept: valid.length, dropped };
  }
}

// Upload a sealed event log with full poison-batch protection. This is the
// queue-aware wrapper around transferEventLog used by the drains; it enforces
// the max-age and max-retry bounds and performs partial-rejection salvage.
async function processSealedBatch(batchPath, backendUrl, timeoutMs) {
  if (!fs.existsSync(batchPath)) return "skip";

  const baseName = path.basename(batchPath);

  // Max-age give-up: a batch we still can't deliver after BATCH_MAX_AGE_MS is
  // treated as undeliverable, independent of why each attempt failed.
  const sealTime = batchSealTimeMs(batchPath);
  if (sealTime != null && Date.now() - sealTime > BATCH_MAX_AGE_MS) {
    quarantineFile(batchPath, `exceeded max age (${Math.round(BATCH_MAX_AGE_MS / 86400000)}d)`);
    clearBatchMeta(batchPath);
    return "poison";
  }

  const outcome = await transferEventLog(batchPath, backendUrl, timeoutMs);

  if (outcome === "sent" || outcome === "skip") {
    clearBatchMeta(batchPath);
    return outcome;
  }

  if (outcome === "poison") {
    const salv = salvageBatch(batchPath);
    if (salv.rewrote) {
      console.error(
        `[skillmeter] Salvaged ${baseName}: dropped ${salv.dropped} invalid line(s), retrying ${salv.kept} valid`
      );
      const retryOutcome = await transferEventLog(batchPath, backendUrl, timeoutMs);
      if (retryOutcome === "sent") {
        clearBatchMeta(batchPath);
        return "sent";
      }
      if (retryOutcome === "retry") {
        return "retry";
      }
      quarantineFile(batchPath, "still rejected after partial-rejection salvage");
      clearBatchMeta(batchPath);
      return "poison";
    }
    quarantineFile(
      batchPath,
      salv.dropped > 0 ? "no salvageable lines remain" : "server rejected payload (permanent)"
    );
    clearBatchMeta(batchPath);
    return "poison";
  }

  // Transient failure: bump the attempt counter and quarantine once we've
  // burned through the retry budget.
  const meta = readBatchMeta(batchPath);
  meta.attempts += 1;
  if (meta.attempts >= MAX_BATCH_RETRIES) {
    quarantineFile(batchPath, `exceeded ${MAX_BATCH_RETRIES} retries`);
    clearBatchMeta(batchPath);
    return "poison";
  }
  writeBatchMeta(batchPath, meta);
  return "retry";
}

// Upload a staged transcript with poison protection. Transcripts aren't
// timestamped in their names, so the max-age give-up uses the file mtime (which
// is refreshed on every re-stage); permanent rejections are quarantined at once.
async function processPendingTranscript(pendingPath, deviceId, backendUrl, timeoutMs) {
  if (!fs.existsSync(pendingPath)) return "skip";

  let mtimeMs = Date.now();
  try { mtimeMs = fs.statSync(pendingPath).mtimeMs; } catch {}
  if (Date.now() - mtimeMs > BATCH_MAX_AGE_MS) {
    quarantineFile(pendingPath, `transcript exceeded max age (${Math.round(BATCH_MAX_AGE_MS / 86400000)}d)`);
    return "poison";
  }

  const outcome = await uploadPendingTranscript(pendingPath, deviceId, backendUrl, timeoutMs);
  if (outcome === "poison") {
    quarantineFile(pendingPath, "transcript rejected by server (permanent)");
  }
  return outcome;
}

async function drainFailedLogs(backendUrl = getBackendUrl(process.cwd()), timeoutMs) {
  const files = listSealedEventLogs();
  if (files.length === 0) return 0;
  console.error(`[skillmeter] Draining ${files.length} sealed event log(s)`);
  await Promise.allSettled(
    files.map((filePath) => processSealedBatch(filePath, backendUrl, timeoutMs))
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
    files.map((filePath) => processPendingTranscript(filePath, deviceId, backendUrl, timeoutMs))
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
 * network I/O. The child inherits the environment and re-resolves the backend
 * URL itself — that keeps the JWT-derived per-tenant endpoint correct (freezing
 * it into SKILLMETER_BACKEND_URL would make the child re-validate a tenant host
 * against the trusted-domain allow-list and fall back to the default).
 */
function spawnDetachedDrain() {
  if (!shouldSpawnDrainOnce()) return false;

  const script = path.join(PLUGIN_ROOT, "scripts", "drain_once.js");
  try {
    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: "ignore",
      env: process.env,
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
      env: process.env,
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
        // Uploaded batches, plus orphaned attempt-meta sidecars whose batch has
        // already been sent or quarantined (so they never leak).
        if (/^events\.jsonl\.\d+\.sent$/.test(f)) {
          candidates.push(path.join(LOG_DIR, f));
        } else if (/^events\.jsonl\.\d+\.meta$/.test(f)) {
          const batch = path.join(LOG_DIR, f.replace(/\.meta$/, ""));
          if (!fs.existsSync(batch)) candidates.push(path.join(LOG_DIR, f));
        } else if (/\.tmp-\d+-[0-9a-f]+$/.test(f)) {
          // Orphaned atomic-write temp file from a crash mid-rename.
          candidates.push(path.join(LOG_DIR, f));
        }
      }
    } catch {}
  }

  // Quarantined poison batches: kept for forensics, but bounded by the same
  // 30-day retention so they can't accumulate indefinitely either.
  if (fs.existsSync(POISON_DIR)) {
    try {
      for (const f of fs.readdirSync(POISON_DIR)) {
        candidates.push(path.join(POISON_DIR, f));
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

  // Atomic single-write append so concurrent hook processes can't splice
  // partial records into the active log and produce an un-parseable batch.
  atomicAppendLine(LOG_FILE, JSON.stringify(logEntry));
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
  tryRefreshLicense,
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
  // Poison-batch handling + atomic writes
  atomicAppendLine,
  atomicWriteFileSync,
  isPermanentHttpStatus,
  salvageBatch,
  quarantineFile,
  processSealedBatch,
  processPendingTranscript,
  readBatchMeta,
  writeBatchMeta,
  clearBatchMeta,
  batchMetaPath,
  POISON_DIR,
  MAX_BATCH_RETRIES,
  BATCH_MAX_AGE_MS,
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

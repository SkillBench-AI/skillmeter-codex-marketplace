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
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { sanitizeEventData } = require("./sanitizer");
const credstore = require("./credstore");
const transcriptQueue = require("./lib/transcript-delta");
const {
  getEndpointFromToken,
  getEndpointFromTokenAllowExpired,
  isJwtExpired,
  decodeJwtPayload,
} = require("./lib/jwt");
const { trySilentGhActivate, refreshExpiredJwt } = require("./lib/license-activation");
const { resolveOrgScope } = require("./lib/org-scope");

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
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const CODEX_SESSIONS_DIR = path.join(CODEX_HOME, "sessions");

// Staged transcripts awaiting upload live here. Sanitized snapshots are written
// before any network call so a failed upload can be retried from disk by the
// detached drain / retry monitor instead of being lost when the hook exits.
const TRANSCRIPTS_PENDING_DIR = path.join(LOG_DIR, "transcripts", "pending");

const TRANSCRIPT_CHUNKS_DIR = path.join(LOG_DIR, "transcripts", "chunks-v1");
const TRANSCRIPT_CAPTURES_DIR = path.join(LOG_DIR, "transcripts", "captures-v1");

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

function getTelemetryGloballyDisabled() {
  return credstore.getTelemetryDisabled();
}

function setTelemetryGloballyDisabled(disabled) {
  return credstore.setTelemetryDisabled(disabled);
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

// Optional narrowing allow-list of GitHub orgs. When configured, repo-scope is
// restricted to the *intersection* of this list and the signed-in user's org
// memberships, so a user whose account belongs to several orgs can scope
// telemetry to just one (e.g. only "skillbench-ai"). The filter can only narrow
// the captured set, never widen it — an org you aren't a member of is still
// blocked even if it's listed. Returns null when unconfigured, preserving the
// default "all signed-in orgs" behavior. Resolution (env → per-project setting)
// lives in lib/org-scope so the sign-in flow narrows identically.
function getRepoScopeOrgFilter(cwd) {
  return resolveOrgScope({ cwd });
}

// Decide whether an event from `cwd` is in-scope. Telemetry fires only in
// repos whose GitHub remote belongs to the signed-in user's own login or one
// of their org memberships, captured from `GET /user` + `GET /user/orgs` at
// signin and stored in ~/.skillbench/credentials.json. With no signed-in orgs
// the result is `not_activated` and everything is dropped — there is no
// permissive "unscoped"/allow-all default. Non-git directories, non-GitHub
// remotes, and repos outside the allowed orgs are all blocked.
//
// The signed-in org set may be further narrowed by an optional org filter
// (getRepoScopeOrgFilter); when set, only repos in orgs that are both
// signed-in *and* on the filter are in scope.
function getRepoScopeDecision(cwd) {
  const signedInOrgs = credstore.getAllowedGitHubOrgs();
  if (signedInOrgs.length === 0) {
    return { allowed: false, scope: "unknown", classification: "not_activated" };
  }

  // Narrow to the configured org allow-list when present (intersection only —
  // never widens the signed-in set). An empty intersection means every repo
  // falls through to the github_org_mismatch path below.
  const orgFilter = getRepoScopeOrgFilter(cwd);
  const allowedOrgs = orgFilter
    ? signedInOrgs.filter((org) => orgFilter.includes(org))
    : signedInOrgs;

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
// command so the upload never contains a literal user path. Secret / PII
// scrubbing of the remaining string values is handled by the central
// sanitizeEventData boundary in runHook, so this stage only owns path hashing.
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
// The ingest endpoint is resolved at upload time in this order (matching the
// Claude plugin's approach — environment selection lives on the activation side
// via `activate_url`/SKILLMETER_ACTIVATE_URL, and the upload host is read back
// out of the license JWT rather than configured separately):
//   1. SKILLMETER_BACKEND_URL env var (full ingest URL; dev/test bypass that
//      skips the JWT entirely — point it at a fake server without a token).
//   2. JWT-derived per-tenant endpoint: the `aud` (audience) claim of the
//      license JWT, with the /logs/codex route appended. This routes each
//      tenant's traffic to its own meter host without per-tenant plugin builds.
//      (The legacy `telemetry_endpoint` claim is deprecated and no longer read.)
//      The claim is read even from an expired token (allow-expired) so a drain
//      still reaches the right host while a refresh is pending — the collector
//      accepts unauthenticated uploads, and routing is not an auth decision.
//   3. DEFAULT_BACKEND_URL (prod) — fallback when unauthenticated or the JWT
//      carries no endpoint.
// The env override (1) is user-supplied so it's validated against the
// trusted-domain allow-list; the JWT endpoint (2) is server-minted and trusted
// as-is (see lib/jwt.js).
// Prod telemetry lives on the greenfield skillbench.ai zone: the activation
// Lambda mints the per-tenant meter URL into the `aud` claim, of the form
// https://{slug}.meter.skillbench.ai (prod) / https://{slug}.meter.dev.skillbench.com
// (dev). This default is only the unauthenticated fallback — real routing comes
// from the JWT claim.
const DEFAULT_BACKEND_URL = "https://api.meter.skillbench.ai/logs/codex";

// Trusted domain patterns for backend URL validation. Prod tenants are on
// *.meter.skillbench.ai; dev/non-prod on *.meter.dev.skillbench.com (the
// legacy *.meter.skillbench.com patterns are retained for back-compat).
const TRUSTED_BACKEND_PATTERNS = [
  /^https:\/\/api\.meter\.skillbench\.ai\//,
  /^https:\/\/[a-z0-9-]+\.meter\.skillbench\.ai\//,
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

function getBackendUrl() {
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

  // Per-tenant routing: a signed-in user's license JWT carries the tenant's
  // meter host in its `aud` (audience) claim. Prefer a fresh token, but fall
  // back to the claim of an expired one (allow-expired) so a drain still reaches
  // the correct tenant host while a refresh is pending. Append the Codex ingest
  // route, then fall through to the prod default when there's no usable token —
  // preserving the unauthenticated upload path.
  const token = getLicenseToken();
  const endpoint =
    getEndpointFromToken(token) || getEndpointFromTokenAllowExpired(token);
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
  if (getTelemetryGloballyDisabled()) {
    console.error(`[skillmeter] Event log transfer skipped (telemetry globally disabled)`);
    return Promise.resolve("skip");
  }

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
// Immutable sanitized chunks and their cursor commit before any network call.
// Legacy TRANSCRIPTS_PENDING_DIR snapshots remain available for selected recovery.
// ---------------------------------------------------------------------------

function transcriptScope(cwd) {
  credstore.refreshFromDisk?.();
  if (getTelemetryGloballyDisabled() || credstore.getSignedOut()) return null;
  const token = getLicenseToken();
  if (!token || isJwtExpired(token)) return null;
  const decision = getRepoScopeDecision(cwd);
  if (!decision.allowed || !resolveTelemetryGate(getTelemetryOptIn(cwd), true).capture) return null;
  const salt = getOrCreateHashSalt(), deviceId = getDeviceId();
  if (!salt || !deviceId) return null;
  const claims = decodeJwtPayload(token);
  const identity = claims.github_id || claims.user_alt_id;
  // Tokens without a stable principal can stage, but rotation requires a new
  // capture. Never deliver one principal's queued transcript as another user.
  const owner = transcriptQueue.hmac(salt, JSON.stringify([claims.iss, claims.aud, claims.sub, identity || token]));
  return { cwd: path.resolve(cwd), repoRoot: decision.repoRoot, org: decision.remoteOrg, deviceId, owner };
}
function scopeStillAllowed(scope) {
  const current = transcriptScope(scope.cwd);
  return current && ["repoRoot", "org", "deviceId", "owner"].every(k => current[k] === scope[k]);
}
function stageTranscriptForUpload(transcriptPath, context = {}) {
  const cwd = context.cwd || process.cwd();
  const scope = transcriptScope(cwd);
  if (!scope || (context.scope && !scopeStillAllowed(context.scope))) return null;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  try {
    const result = transcriptQueue.stage(TRANSCRIPT_CHUNKS_DIR, transcriptPath, scope, getOrCreateHashSalt(), {
      authorizeRecord: record => {
        if (!["session_meta", "turn_context"].includes(record.type) || !record.payload?.cwd) return true;
        const sourceScope = transcriptScope(record.payload.cwd);
        return sourceScope && sourceScope.repoRoot === scope.repoRoot && sourceScope.owner === scope.owner;
      },
    });
    return result.files[0] || null;
  } catch {
    console.error("[skillmeter] Transcript staging failed; source/cursor retained, see queue diagnostic");
    return null;
  }
}

async function sendTranscriptChunk(meta, compressed, backendUrl, timeoutMs) {
  if (!scopeStillAllowed(meta.scope)) return "skip";
  const token = getLicenseToken();
  try {
    const res = await fetch(`${backendUrl || getBackendUrl(meta.scope.cwd)}/transcript`, {
      method: "POST",
      headers: commonHeaders(token, {
        "X-Device-ID": meta.scope.deviceId,
        "X-Transcript-ID": meta.transcriptId,
        "X-Transcript-Protocol": "codex-chunks-v1",
        "X-Chunk-Seq": String(meta.seq),
        "X-Chunk-Reset": String(meta.reset),
      }),
      body: compressed,
      signal: AbortSignal.timeout(timeoutMs || TRANSCRIPT_TIMEOUT),
    });
    if (res.ok) return "sent";
    if (res.status === 409 && (await res.json()).error === "transcript-baseline-missing") return "reset-required";
    // Auth rejection must not clear shared credentials or fall back to anonymous
    // transcript upload. Keep this chunk and all later chunks for scoped retry.
    if (meta.queueDir) transcriptQueue.writeDurable(path.join(meta.queueDir, "diagnostic.json"),
      JSON.stringify({ code: `http-${res.status}`, seq: meta.seq, at: new Date().toISOString() }));
    console.error(`[skillmeter] Transcript chunk ${meta.seq}: HTTP ${res.status}; retained`);
    return (res.status === 401 || res.status === 403) ? "skip" : "retry";
  } catch { return "retry"; }
}

async function uploadPendingTranscript(pendingPath, deviceId, backendUrl, timeoutMs) {
  if (!pendingPath || !fs.existsSync(pendingPath)) return "skip";
  if (!path.resolve(pendingPath).startsWith(TRANSCRIPT_CHUNKS_DIR + path.sep)) {
    // Legacy snapshots have no sequence/scope journal. Preserve for selected
    // recovery; never auto-migrate or quarantine historical data on startup.
    return "skip";
  }
  const meta = transcriptQueue.metadata(pendingPath);
  if (deviceId !== meta.scope.deviceId) return "skip";
  const dir = path.dirname(path.dirname(pendingPath));
  let outcome = "skip";
  await drainTranscriptDirectory(dir, async (chunk, body) => {
    outcome = await sendTranscriptChunk({ ...chunk, queueDir: dir }, body, backendUrl, timeoutMs);
    return outcome;
  });
  return outcome;
}

function transferTranscript(transcriptPath, deviceId, backendUrl, context = {}) {
  const pending = stageTranscriptForUpload(transcriptPath, context);
  return pending ? uploadPendingTranscript(pending, deviceId, backendUrl) : Promise.resolve("skip");
}

// Small durable capture hints keep all raw reading/gzip work off hook deadlines.
// Only currently authorized lifecycle paths enter this index; it does not scan
// historical sessions. Rechecks run again at capture and at every chunk send.
function requestTranscriptCapture(input, options = {}) {
  const cwd = input?.cwd || process.cwd(), scope = transcriptScope(cwd);
  if (!scope) return 0;
  fs.mkdirSync(TRANSCRIPT_CAPTURES_DIR, { recursive: true, mode: 0o700 });
  const salt = getOrCreateHashSalt();
  const cacheKey = transcriptQueue.hmac(salt, String(input.session_id || "unknown"));
  const cachePath = path.join(TRANSCRIPT_CAPTURES_DIR, cacheKey + ".json");
  let paths = collectTranscriptPaths(input, { ...options, discover: options.discover !== false });
  if (!paths.length && fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (scopeStillAllowed(cached.scope)) paths = cached.paths;
  }
  if (!paths.length) return 0;
  transcriptQueue.writeDurable(cachePath, JSON.stringify({ scope, paths }));
  return paths.length;
}
function stageRequestedTranscripts() {
  if (!fs.existsSync(TRANSCRIPT_CAPTURES_DIR)) return;
  for (const name of fs.readdirSync(TRANSCRIPT_CAPTURES_DIR).filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
    try {
      const capture = JSON.parse(fs.readFileSync(path.join(TRANSCRIPT_CAPTURES_DIR, name), "utf8"));
      if (!scopeStillAllowed(capture.scope)) continue;
      for (const source of capture.paths) stageTranscriptForUpload(source, { cwd: capture.scope.cwd, scope: capture.scope });
    } catch { console.error("[skillmeter] Capture hint unavailable; retained for retry"); }
  }
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
  return transcriptQueue.queueDirectories(TRANSCRIPT_CHUNKS_DIR).flatMap(transcriptQueue.pendingFiles);
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
  if (getTelemetryGloballyDisabled()) {
    console.error(`[skillmeter] Batch processing skipped (telemetry globally disabled)`);
    return "skip";
  }

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

// Compatibility entry point for callers holding a durable gzip chunk path.
async function processPendingTranscript(pendingPath, deviceId, backendUrl, timeoutMs) {
  return uploadPendingTranscript(pendingPath, deviceId, backendUrl, timeoutMs);
}

async function drainFailedLogs(backendUrl = getBackendUrl(process.cwd()), timeoutMs) {
  if (getTelemetryGloballyDisabled()) {
    console.error(`[skillmeter] Event-log drain skipped (telemetry globally disabled)`);
    return 0;
  }
  const files = listSealedEventLogs();
  if (files.length === 0) return 0;
  console.error(`[skillmeter] Draining ${files.length} sealed event log(s)`);
  await Promise.allSettled(
    files.map((filePath) => processSealedBatch(filePath, backendUrl, timeoutMs))
  );
  return files.length;
}

// One bounded recovery attempt per sweep. The durable reset request survives
// process death, a missing raw source, consent changes and network failures.
async function drainTranscriptDirectory(dir, send) {
  await transcriptQueue.drainDirectory(dir, send);
  const request = path.join(dir, "reset-request.json"), cursorFile = path.join(dir, "cursor.json");
  if (fs.existsSync(request) && fs.existsSync(cursorFile)) {
    const cursor = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
    const reset = JSON.parse(fs.readFileSync(request, "utf8"));
    if (reset.baseline >= cursor.baseline && cursor.source && scopeStillAllowed(cursor.scope)) {
      const staged = stageTranscriptForUpload(cursor.source, { cwd: cursor.scope.cwd, scope: cursor.scope });
      if (staged) await transcriptQueue.drainDirectory(dir, send);
    }
  }
}

async function drainPendingTranscripts(backendUrl, timeoutMs) {
  if (getTelemetryGloballyDisabled() || credstore.getSignedOut()) return 0;
  stageRequestedTranscripts();
  let count = 0;
  for (const dir of transcriptQueue.queueDirectories(TRANSCRIPT_CHUNKS_DIR)) {
    try {
      // The retry monitor needs work found, including failed uploads. Counting
      // only acknowledgments would make an outage look like an idle queue.
      count += transcriptQueue.pendingFiles(dir).length;
      await drainTranscriptDirectory(dir, (meta, body) => sendTranscriptChunk({ ...meta, queueDir: dir }, body, backendUrl, timeoutMs));
    } catch {
      console.error("[skillmeter] Transcript queue unavailable; retained while other queues continue");
      try {
        transcriptQueue.writeDurable(path.join(dir, "diagnostic.json"),
          JSON.stringify({ code: "queue-unavailable", at: new Date().toISOString() }));
      } catch {
        console.error("[skillmeter] Could not persist transcript queue diagnostic");
      }
    }
  }
  return count;
}

/**
 * Drain both durable queues once. Returns the number of queued items found
 * (pre-drain), which callers use to decide whether work remains.
 */
async function drainQueuesOnce(backendUrl = getBackendUrl(process.cwd()), timeoutMs) {
  if (getTelemetryGloballyDisabled()) {
    console.error(`[skillmeter] Queue drain skipped (telemetry globally disabled)`);
    return 0;
  }
  const logs = await drainFailedLogs(backendUrl, timeoutMs);
  const transcripts = await drainPendingTranscripts(undefined, timeoutMs);
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
        if (/^events\.jsonl\.\d+(?:\.meta)?$/.test(f)) candidates.push(path.join(POISON_DIR, f));
      }
    } catch {}
  }

  // Legacy transcript snapshots/poison and new chunks require selected recovery.
  // Never expire the only retained copy automatically during this migration.

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

function safeTranscriptCandidate(candidate) {
  if (!candidate || typeof candidate !== "string") return "";
  try {
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? path.resolve(candidate)
      : "";
  } catch {
    return "";
  }
}

function transcriptFileMatchesSession(filePath, sessionId) {
  if (path.basename(filePath).includes(sessionId)) return true;
  try {
    const fd = fs.openSync(filePath, "r");
    let firstLine = "";
    try {
      const buf = Buffer.alloc(8192);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      firstLine = buf.toString("utf8", 0, bytes).split("\n", 1)[0];
    } finally {
      fs.closeSync(fd);
    }
    if (!firstLine) return false;
    const record = JSON.parse(firstLine);
    return record && record.payload && record.payload.id === sessionId;
  } catch {
    return false;
  }
}

function findCodexTranscriptBySessionId(sessionId, sessionsDir = CODEX_SESSIONS_DIR) {
  if (!sessionId || typeof sessionId !== "string") return "";
  if (!fs.existsSync(sessionsDir)) return "";

  const stack = [sessionsDir];
  const candidates = [];
  let visited = 0;
  const maxVisited = 5000;

  while (stack.length > 0 && visited < maxVisited) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (visited++ >= maxVisited) break;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      if (transcriptFileMatchesSession(p, sessionId)) {
        try {
          candidates.push({ path: p, mtimeMs: fs.statSync(p).mtimeMs });
        } catch {}
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] ? candidates[0].path : "";
}

function collectTranscriptPaths(input, options = {}) {
  const paths = [];
  const seen = new Set();
  const add = (candidate) => {
    const p = safeTranscriptCandidate(candidate);
    if (!p || seen.has(p)) return;
    seen.add(p);
    paths.push(p);
  };

  if (input) {
    // SubagentStop has its own transcript in addition to the parent session
    // transcript. Stage both when available so subagent conversations are not
    // hidden behind the common transcript_path field.
    add(input.agent_transcript_path);
    add(input.transcript_path);

    if (paths.length === 0 && options.discover !== false) {
      add(findCodexTranscriptBySessionId(input.session_id, options.sessionsDir));
    }
  }

  return paths;
}

/**
 * Seal final-session artifacts into durable queues and kick off a detached
 * drain. Uploading is left to the drain / retry monitor so the hook returns
 * quickly instead of blocking on network I/O.
 */
function sealFinalSessionArtifacts(input) {
  const sealed = sealEventLog();

  const captured = requestTranscriptCapture(input, { discover: false });
  if (sealed || captured) spawnDetachedDrain();
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
//
// Consent is collected entirely in-context: an explicit per-project opt-in
// (`telemetry.js enable/disable`, stored in `.codex/settings.local.json`) plus
// owned-org auto-enable, so a repo owned by an allowed org captures without any
// prompt. There is deliberately no OS-native dialog — Codex hooks usually run
// without a TTY, and a system pop-up reads as spyware, fatigues users across
// repos, and can't render on headless/SSH/CI. This matches the Claude Code
// plugin and the VS Code extension, so consent is consistent across products.
// ---------------------------------------------------------------------------

function telemetryCliCommand(action) {
  return `node ${JSON.stringify(path.join(PLUGIN_ROOT, "scripts", "telemetry.js"))} ${action}`;
}

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

// In-context consent notice: printed to a Codex hook's stderr channel when a
// project has no explicit opt-in and isn't owned-org auto-enabled. No decision
// is saved — the project stays "not configured" until the user runs
// `telemetry.js enable|disable`.
function writeTelemetryConsentFallback(cwd, stream = process.stderr) {
  stream.write(
    [
      `SkillMeter: Telemetry is not configured for ${cwd}`,
      "SkillMeter: Enable or disable telemetry for this project with:",
      `  ${telemetryCliCommand("enable")}`,
      `  ${telemetryCliCommand("disable")}`,
      `  ${telemetryCliCommand("status")}`,
      "",
    ].join("\n")
  );
}

/**
 * Resolve the per-project telemetry gate, combining the explicit opt-in setting
 * with owned-org auto-enable (parity with the Claude Code plugin):
 *
 *   - explicit `false` → off  (user opted out; always respected)
 *   - explicit `true`  → on   (subject to the repo-scope gate downstream)
 *   - unset (`null`)   → on **only when the repo is owned by an allowed org**
 *                        ("auto_org"); otherwise off ("not_enabled")
 *
 * Pure function — no I/O — so the policy can be reasoned about and tested
 * directly.
 *
 * @param {boolean|null} optIn - getTelemetryOptIn(cwd) result
 * @param {boolean} repoOrgOwned - repoScopeDecision.allowed
 * @returns {{capture: boolean, mode: "opted_out"|"opted_in"|"auto_org"|"not_enabled"}}
 */
function resolveTelemetryGate(optIn, repoOrgOwned) {
  if (optIn === false) return { capture: false, mode: "opted_out" };
  if (optIn === true) return { capture: true, mode: "opted_in" };
  if (repoOrgOwned === true) return { capture: true, mode: "auto_org" };
  return { capture: false, mode: "not_enabled" };
}

// Default stderr messaging for the resolved gate, used by every hook that
// doesn't supply an onGate reactor (i.e. every hook except SessionStart).
function defaultGateMessaging(eventName, gate) {
  if (!gate.capture) {
    const reason =
      gate.mode === "opted_out"
        ? "telemetry disabled for this project"
        : "telemetry not enabled";
    console.error(`[skillmeter] ${eventName}: skipped (${reason})`);
    return;
  }
  if (gate.mode === "auto_org") {
    console.error(
      `[skillmeter] ${eventName}: telemetry auto-enabled (repo owned by allowed org; run \`${telemetryCliCommand("disable")}\` to opt out)`
    );
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
 * @param {function} [options.onGate] - Gate reactor: ({ gate, repoScopeDecision, cwd, input, eventName }) => void.
 *   Runs after the gate is resolved (for banners/side-effects). The capture decision stays central —
 *   runHook exits when gate.capture is false regardless. Without it, default stderr messaging is used.
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

  if (getTelemetryGloballyDisabled()) {
    console.error(`[skillmeter] ${eventName}: skipped (telemetry globally disabled)`);
    return exit(0);
  }

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

  // Resolve repo ownership up front: it both gates capture (below) and, for
  // projects with no explicit opt-in, decides whether telemetry auto-enables.
  const repoScopeDecision = getRepoScopeDecision(cwd);

  // Single per-project gate combining the explicit opt-in with owned-org
  // auto-enable. Callers REACT via onGate (banners/side-effects); the capture
  // decision stays central — runHook exits below when gate.capture is false.
  // Hooks without an onGate get the default stderr messaging. (Replaces the
  // former OS consent dialog + per-hook checkOptIn override.)
  const gate = resolveTelemetryGate(getTelemetryOptIn(cwd), repoScopeDecision.allowed);
  if (options.onGate) {
    options.onGate({ gate, repoScopeDecision, cwd, input, eventName });
  } else {
    defaultGateMessaging(eventName, gate);
  }
  if (!gate.capture) return exit(0);

  const sessionId = input.session_id || "unknown";
  const hashSalt = getOrCreateHashSalt();
  if (!hashSalt) {
    console.error(`[skillmeter] ${eventName}: skipped (no hash salt)`);
    return exit(0);
  }

  // Hard repo-scope block: only opted_in projects can reach here on a repo not
  // owned by an allowed org (auto_org requires allowed=true). Drop those events.
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

  const rawData = {
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

  // Single deterministic pre-upload sanitization boundary (SBEE-155). Every
  // hook routes its event data through here, so raw user content — the
  // submitted prompt, last_assistant_message, tool descriptions, tool
  // arguments, and tool output — is scrubbed of Tier 1 secrets and Tier 2
  // identifiers before it is ever written to the durable queue or uploaded.
  // Running it centrally means a new hook field can't accidentally bypass the
  // sanitizer, and the redaction counts/types travel with the event.
  const { value: data, meta } = sanitizeEventData(rawData);
  if (meta.tier1 > 0 || meta.tier2 > 0) {
    data._sanitization = meta;
    console.error(
      `[skillmeter] ${eventName}: redacted ${meta.tier1} secret(s) and ${meta.tier2} identifier(s) before upload`
    );
  }

  logInfo(eventName, sessionId, data, deviceId);
  console.error(
    `[skillmeter] ${eventName}: logged (session=${String(sessionId).slice(0, 8)}…)`
  );

  try {
    if (requestTranscriptCapture(input, { discover: !["SessionEnd", "Interrupt", "Stop", "SubagentStop"].includes(eventName) })) {
      spawnDetachedDrain();
    }
  } catch { console.error("[skillmeter] Capture hint failed; next lifecycle event can retry"); }

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
  getTelemetryGloballyDisabled,
  setTelemetryGloballyDisabled,
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
  safeTranscriptCandidate,
  transcriptFileMatchesSession,
  findCodexTranscriptBySessionId,
  collectTranscriptPaths,
  stageTranscriptForUpload,
  requestTranscriptCapture,
  stageRequestedTranscripts,
  TRANSCRIPT_CHUNKS_DIR,
  TRANSCRIPT_CAPTURES_DIR,
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
  writeTelemetryConsentFallback,
  resolveTelemetryGate,
  defaultGateMessaging,
  getRepoScopeDecision,
  getRepoScopeOrgFilter,
  runHook,
  PLUGIN_ROOT,
  PLUGIN_DATA,
  PLUGIN_VERSION,
  LOG_DIR,
  LOG_FILE,
  CODEX_HOME,
  CODEX_SESSIONS_DIR,
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

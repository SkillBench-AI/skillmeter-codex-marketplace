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
const repositoryQueue = require("./lib/repository-queue");
const {isWorkSource} = require("./lib/work-local");
const {workCapture} = require("./lib/work-runtime");
const {
  getEndpointFromToken,
  getEndpointFromTokenAllowExpired,
  isJwtExpired,
  decodeJwtPayload,
} = require("./lib/jwt");
const { ensureFreshLicense } = require("./lib/license-activation");
const retention = require("./lib/queue-retention");
const { resolveOrgScope } = require("./lib/org-scope");
const telemetryStore = require("./lib/telemetry-store");
const { resolveTelemetryGate } = require("./lib/telemetry-policy");
const { getRepoScopeDecision, extractGitHubOrgFromRemote } = require("./lib/repo-scope");
const { findGitRoot } = require("./lib/io");
const { STATE_DIR } = require("./lib/config");

// Codex sets PLUGIN_ROOT for plugin-bundled hooks and also exports
// CLAUDE_PLUGIN_ROOT for compatibility with existing plugin hook scripts.
const PLUGIN_ROOT =
  process.env.PLUGIN_ROOT ||
  process.env.CLAUDE_PLUGIN_ROOT ||
  path.resolve(__dirname, "..");

// Use a persistent user-state directory when the host supplies no data path.
// Never write telemetry into the versioned plugin installation.
const PLUGIN_DATA =
  process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || path.join(STATE_DIR, "codex");

const LOG_DIR = path.join(PLUGIN_DATA, "logs");
const LOG_FILE = path.join(LOG_DIR, "events.jsonl"); // legacy, never auto-delivered
const REPOSITORIES_LOG_DIR = path.join(LOG_DIR, "repositories");
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
  stageRequestedTranscripts();
  const result = credstore.setTelemetryDisabled(disabled);
  if (disabled) workCapture().disable();
  stageRequestedTranscripts();
  return result;
}

// ---------------------------------------------------------------------------
// License refresh follows the shared ADR001 outcome/status model.
// ---------------------------------------------------------------------------
async function tryRefreshLicense(deviceId, options) {
  try { return await ensureFreshLicense(deviceId, options); }
  catch { console.error("[skillmeter] License recovery unavailable; retry at next lifecycle boundary"); return null; }
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

// Kept for legacy sign-in diagnostics only. Membership filters never widen
// capture scope, which is now read exclusively from the license organization.
function getRepoScopeOrgFilter(cwd) { return resolveOrgScope({ cwd }); }

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

// Resolve every delivery from the current license audience. An explicit trusted
// development override still requires authentication; neither missing identity
// nor invalid routing may fall through to a production destination.
const DEFAULT_BACKEND_URL = null;

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

function getBackendUrl(_cwd, token) {
  if (token === undefined) { credstore.refreshFromDisk?.(); token = getLicenseToken(); }
  const override = process.env.SKILLMETER_BACKEND_URL;
  if (override) return isValidBackendUrl(override) ? override : null;
  const endpoint = getEndpointFromToken(token);
  const url = endpoint ? `${endpoint}${INGEST_ROUTE}` : null;
  return isValidBackendUrl(url) ? url : null;
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

// Callers must authorize the queue and supply a valid token before sending.
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
// Authentication outcomes retain queued data and never consume the poison
// retry budget. Other 4xx responses except 408/429 are payload rejections.
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
async function transferEventLog(logFile, backendUrl, timeoutMs = EVENT_TIMEOUT) {
  if (!retention.enforce()) return "skip";
  if (!logFile || !fs.existsSync(logFile)) return "skip";
  if (getTelemetryGloballyDisabled() || credstore.getSignedOut()) return "skip";
  credstore.refreshFromDisk?.();
  const token = getLicenseToken();
  if (!token || isJwtExpired(token)) return "auth";
  const context = repositoryQueue.forFile(REPOSITORIES_LOG_DIR, logFile);
  if (!context) return "skip";
  if (repositoryQueue.disposition(context.scope) === "delete") { repositoryQueue.purge(context); return "skip"; }
  if (!scopeStillAllowed(context.scope, token)) return "skip";
  const destination = getBackendUrl(undefined, token);
  if (!destination || (backendUrl && backendUrl !== destination)) return "auth";
  try {
    const compressed = zlib.gzipSync(fs.readFileSync(logFile));
    const res = await fetch(destination, {
      method: "POST",
      headers: commonHeaders(token),
      body: compressed,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      fs.renameSync(logFile, `${logFile}.sent`);
      return "sent";
    }
    if ([401, 402, 403].includes(res.status)) return "auth";
    return isPermanentHttpStatus(res.status) ? "poison" : "retry";
  } catch { return "retry"; }
}

// ---------------------------------------------------------------------------
// Transcript staging + upload
//
// Immutable sanitized chunks and their cursor commit before any network call.
// Legacy TRANSCRIPTS_PENDING_DIR snapshots remain available for selected recovery.
// ---------------------------------------------------------------------------

function transcriptScope(cwd, requireConsent = true, requestToken) {
  credstore.refreshFromDisk?.();
  if (requireConsent && credstore.getSignedOut()) return null;
  const token = requestToken === undefined ? getLicenseToken() : requestToken;
  if (!token || !Number.isFinite(decodeJwtPayload(token)?.exp)) return null;
  const decision = getRepoScopeDecision(cwd);
  if (!decision.allowed || (requireConsent && !captureGate(cwd).capture)) return null;
  const salt = getOrCreateHashSalt(), deviceId = getDeviceId();
  if (!salt || !deviceId) return null;
  const claims = decodeJwtPayload(token);
  const identity = claims.github_id || claims.user_alt_id;
  // Tokens without a stable principal can stage, but rotation requires a new
  // capture. Never deliver one principal's queued transcript as another user.
  const owner = transcriptQueue.hmac(salt, JSON.stringify([claims.iss, claims.aud, claims.sub, identity || token]));
  const scope = { cwd: path.resolve(cwd), repoRoot: decision.repoRoot, org: decision.remoteOrg, repoKey: decision.repoKey, deviceId, owner };
  return { ...scope, consentStamp: repositoryQueue.consentStamp(scope) };
}
function scopeStillAllowed(scope, requestToken) {
  const current = transcriptScope(scope.cwd, true, requestToken);
  return current && ["repoKey", "org", "deviceId", "owner", "consentStamp"].every(k => current[k] === scope[k]);
}
function observeTranscriptConsent(source, cwd, verifyReplacement = false) {
  const scope = transcriptScope(cwd, false);
  if (!scope || !source || !fs.existsSync(source)) return null;
  return transcriptQueue.observeConsent(TRANSCRIPT_CHUNKS_DIR, source, scope,
    getOrCreateHashSalt(), captureGate(cwd).capture, scope.consentStamp + JSON.stringify(telemetryStore.readPolicy().global), false, verifyReplacement);
}
function stageTranscriptForUpload(transcriptPath, context = {}) {
  // Work cannot enter the repository upload path, even inside an opted-in repo.
  if (isWorkSource(transcriptPath)) return null;
  if (!retention.enforce()) return null;
  const cwd = context.cwd || process.cwd();
  let consent;
  try { consent = observeTranscriptConsent(transcriptPath, cwd, true); }
  catch { return null; }
  const scope = transcriptScope(cwd);
  if (!consent || !scope || (context.scope && !scopeStillAllowed(context.scope))) return null;
  try {
    const result = transcriptQueue.stage(TRANSCRIPT_CHUNKS_DIR, transcriptPath, scope, getOrCreateHashSalt(), {
      consent,
      preserveSessionMetadata: true,
      authorizeCommit: () => scopeStillAllowed(scope) && consent.stamp === scope.consentStamp + JSON.stringify(telemetryStore.readPolicy().global),
      authorizeRecord: record => {
        if (record.type === "session_meta" && record.payload?.originator === "codex_work_desktop") return false;
        if (!["session_meta", "turn_context"].includes(record.type) || !record.payload?.cwd) return true;
        const sourceScope = transcriptScope(record.payload.cwd);
        return sourceScope && sourceScope.repoKey === scope.repoKey && sourceScope.owner === scope.owner;
      },
    });
    return result.files[0] || null;
  } catch (error) {
    if (error.message === "consent-source-rewritten") {
      // A rewrite invalidates byte-position authorization. Establish a new
      // boundary at the current tail; never infer consent for replacement text.
      transcriptQueue.observeConsent(TRANSCRIPT_CHUNKS_DIR, transcriptPath, scope,
        getOrCreateHashSalt(), true, scope.consentStamp + JSON.stringify(telemetryStore.readPolicy().global), true);
    }
    console.error("[skillmeter] Transcript staging failed; source/cursor retained, see queue diagnostic");
    return null;
  }
}

async function sendTranscriptChunk(meta, compressed, backendUrl, timeoutMs) {
  credstore.refreshFromDisk?.();
  const token = getLicenseToken();
  if (isJwtExpired(token) || !scopeStillAllowed(meta.scope, token)) return "skip";
  try {
    const destination = getBackendUrl(undefined, token);
    if (!destination || (backendUrl && backendUrl !== destination)) return "skip";
    const res = await fetch(`${destination}/transcript`, {
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
  if (!retention.enforce()) return "skip";
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
  const cwd = input?.cwd || process.cwd(), scope = transcriptScope(cwd, false);
  if (!scope) return 0;
  fs.mkdirSync(TRANSCRIPT_CAPTURES_DIR, { recursive: true, mode: 0o700 });
  const salt = getOrCreateHashSalt();
  const cacheKey = transcriptQueue.hmac(salt, String(input.session_id || "unknown"));
  const cachePath = path.join(TRANSCRIPT_CAPTURES_DIR, cacheKey + ".json");
  let paths = collectTranscriptPaths(input, { ...options, discover: options.discover !== false });
  if (!paths.length && fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (cached.scope.owner === scope.owner && cached.scope.repoKey === scope.repoKey) paths = cached.paths;
  }
  if (!paths.length) return 0;
  for (const source of paths) observeTranscriptConsent(source, cwd);
  transcriptQueue.writeDurable(cachePath, JSON.stringify({ scope, paths }));
  return paths.length;
}
function purgeDisallowedTranscriptPayloads() {
  for (const dir of transcriptQueue.queueDirectories(TRANSCRIPT_CHUNKS_DIR)) {
    const cursorFile = path.join(dir, "cursor.json");
    if (!fs.existsSync(cursorFile)) continue;
    try {
      const cursor = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
      if (!cursor.scope?.repoKey || repositoryQueue.disposition(cursor.scope) !== "delete") continue;
      const release = transcriptQueue.acquireLock(path.join(dir, "lock"));
      if (!release) continue;
      try {
        for (const name of fs.readdirSync(dir)) {
          if (/^(batch-|\.stage-)/.test(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        }
      } finally { release(); }
      // OFF revokes queued payloads. Re-enabling starts after the observed tail,
      // and a later missing-baseline reset must not reconstruct revoked history.
      if (fs.existsSync(cursor.source)) observeTranscriptConsent(cursor.source, cursor.scope.cwd);
    } catch { console.error("[skillmeter] Cannot retire revoked transcript payloads; queue remains blocked"); }
  }
}

function stageRequestedTranscripts() {
  if (!fs.existsSync(TRANSCRIPT_CAPTURES_DIR)) return;
  for (const name of fs.readdirSync(TRANSCRIPT_CAPTURES_DIR).filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
    try {
      const capture = JSON.parse(fs.readFileSync(path.join(TRANSCRIPT_CAPTURES_DIR, name), "utf8"));
      for (const source of capture.paths) {
        observeTranscriptConsent(source, capture.scope.cwd);
        if (scopeStillAllowed(capture.scope)) stageTranscriptForUpload(source, { cwd: capture.scope.cwd, scope: capture.scope });
      }
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
function sealEventLog(cwd = process.cwd()) {
  const scope = transcriptScope(cwd);
  const context = scope && repositoryQueue.context(REPOSITORIES_LOG_DIR, scope, getOrCreateHashSalt());
  if (!context) return null;
  return repositoryQueue.withLock(context, () => sealLogFile(context.eventLog));
}

function sealLogFile(logFile) {
  if (!fs.existsSync(logFile)) {
    console.error(`[skillmeter] No event log to seal`);
    return null;
  }

  const baseTimestamp = Date.now();
  for (let attempt = 0; attempt < 100; attempt++) {
    const sealedFile = `${logFile}.${baseTimestamp + attempt}`;
    if (fs.existsSync(sealedFile)) continue;
    try {
      fs.renameSync(logFile, sealedFile);
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
function recoverStaleActiveLog(cwd = process.cwd()) {
  const scope = transcriptScope(cwd);
  const context = scope && repositoryQueue.context(REPOSITORIES_LOG_DIR, scope, getOrCreateHashSalt());
  if (!context) return null;
  let st;
  try {
    st = fs.statSync(context.eventLog);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;

  const age = Date.now() - st.mtimeMs;
  if (age < ACTIVE_LOG_STALE_MS) return null;

  console.error(
    `[skillmeter] Recovering un-rotated event log (idle ${Math.round(age / 1000)}s) from a prior session`
  );
  return sealEventLog(cwd);
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
  return repositoryQueue.list(REPOSITORIES_LOG_DIR).flatMap(context => {
    if (repositoryQueue.disposition(context.scope) === "delete") {
      repositoryQueue.purge(context); return [];
    }
    return fs.readdirSync(context.root).filter(n => /^events\.jsonl\.\d+$/.test(n))
      .map(n => path.join(context.root, n));
  });
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
    const context = repositoryQueue.forFile(REPOSITORIES_LOG_DIR, filePath);
    const poisonDir = context ? path.join(context.root, "poison") : POISON_DIR;
    fs.mkdirSync(poisonDir, { recursive: true, mode: 0o700 });
    const dest = path.join(poisonDir, baseName);
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
  if (!retention.enforce()) return "skip";
  if (!fs.existsSync(batchPath)) return "skip";
  const release = transcriptQueue.acquireLock(`${batchPath}.delivery-lock`);
  if (!release) return "skip";
  try { return await processLockedBatch(batchPath, backendUrl, timeoutMs); }
  finally { release(); }
}

async function processLockedBatch(batchPath, backendUrl, timeoutMs) {
  if (!fs.existsSync(batchPath)) return "skip";
  if (getTelemetryGloballyDisabled()) {
    console.error(`[skillmeter] Batch processing skipped (telemetry globally disabled)`);
    return "skip";
  }

  credstore.refreshFromDisk?.();
  if (isJwtExpired(getLicenseToken())) return "auth";
  const context = repositoryQueue.forFile(REPOSITORIES_LOG_DIR, batchPath);
  if (!context) return "skip";
  if (repositoryQueue.disposition(context.scope) === "delete") { repositoryQueue.purge(context); return "skip"; }
  if (!scopeStillAllowed(context.scope)) return "skip";
  const baseName = path.basename(batchPath);

  credstore.refreshFromDisk?.();
  if (credstore.getSignedOut() || isJwtExpired(getLicenseToken()) || !getBackendUrl()) return "auth";

  // Max-age give-up: a batch we still can't deliver after BATCH_MAX_AGE_MS is
  // treated as undeliverable, independent of why each attempt failed.
  const sealTime = batchSealTimeMs(batchPath);
  if (sealTime != null && Date.now() - sealTime > BATCH_MAX_AGE_MS) {
    quarantineFile(batchPath, `exceeded max age (${Math.round(BATCH_MAX_AGE_MS / 86400000)}d)`);
    clearBatchMeta(batchPath);
    return "poison";
  }

  const outcome = await transferEventLog(batchPath, backendUrl, timeoutMs);

  if (outcome === "auth") return outcome;
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
      if (retryOutcome === "auth" || retryOutcome === "skip") return retryOutcome;
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
  if (!retention.enforce()) return 0;
  if (getTelemetryGloballyDisabled() || credstore.getSignedOut()) return 0;
  purgeDisallowedTranscriptPayloads();
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
  if (!retention.enforce()) return 0;
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
  retention.enforce();
  const now = Date.now();
  const candidates = [];

  for (const directory of [LOG_DIR, ...repositoryQueue.list(REPOSITORIES_LOG_DIR).map(c => c.root)]) {
    if (!fs.existsSync(directory)) continue;
    try {
      for (const f of fs.readdirSync(directory)) {
        // Uploaded batches, plus orphaned attempt-meta sidecars whose batch has
        // already been sent or quarantined (so they never leak).
        if (/^events\.jsonl\.\d+\.sent$/.test(f)) {
          candidates.push(path.join(directory, f));
        } else if (/^events\.jsonl\.\d+\.meta$/.test(f)) {
          const batch = path.join(directory, f.replace(/\.meta$/, ""));
          if (!fs.existsSync(batch)) candidates.push(path.join(directory, f));
        } else if (/\.tmp-\d+-[0-9a-f]+$/.test(f)) {
          // Orphaned atomic-write temp file from a crash mid-rename.
          candidates.push(path.join(directory, f));
        }
      }
    } catch {}
  }

  // Quarantined poison batches: kept for forensics, but bounded by the same
  // 30-day retention so they can't accumulate indefinitely either.
  for (const poisonDir of [POISON_DIR, ...repositoryQueue.list(REPOSITORIES_LOG_DIR).map(c => path.join(c.root, "poison"))]) {
    if (!fs.existsSync(poisonDir)) continue;
    try {
      for (const f of fs.readdirSync(poisonDir)) {
        if (/^events\.jsonl\.\d+(?:\.meta)?$/.test(f)) candidates.push(path.join(poisonDir, f));
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

function logStructured(level, event, sessionId, data, deviceId, scope = transcriptScope(process.cwd())) {
  if (!retention.enforcePending()) return;
  if (!scope || !deviceId || !scopeStillAllowed(scope)) return;
  const context = repositoryQueue.context(REPOSITORIES_LOG_DIR, scope, getOrCreateHashSalt());
  if (!context) return;

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
  repositoryQueue.withLock(context, () => {
    if (scopeStillAllowed(scope)) atomicAppendLine(context.eventLog, JSON.stringify(logEntry));
  });
}

function getTranscriptId(transcriptPath) {
  if (!transcriptPath) return "";
  return path.basename(transcriptPath);
}

const logInfo = (event, sessionId, data, deviceId, scope) =>
  logStructured("info", event, sessionId, data, deviceId, scope);

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
  // An old explicit OFF remains a local veto until the user changes it. Old
  // true/auto-org settings never become new organization/repository consent.
  if (readSettingsFile(cwd)?.skillmeter?.telemetry === false) return false;
  return telemetryStore.getRepositoryOverride(getRepoScopeDecision(cwd).repoKey);
}

function captureGate(cwd) {
  credstore.refreshFromDisk?.();
  const scope = getRepoScopeDecision(cwd);
  return resolveTelemetryGate({
    globalDisabled: getTelemetryGloballyDisabled(),
    hasValidLicense: !credstore.getSignedOut() && Number.isFinite(decodeJwtPayload(getLicenseToken())?.exp),
    cwdAvailable: typeof cwd === "string" && cwd.length > 0,
    repoOrgOwned: scope.allowed,
    orgConsent: telemetryStore.getOrganizationConsent(scope.remoteOrg),
    projectOptIn: getTelemetryOptIn(cwd),
  });
}

function saveTelemetryOptIn(cwd, value) {
  const scope = getRepoScopeDecision(cwd);
  if (!scope.allowed) throw new Error("An eligible repository in the licensed organization is required.");
  if (typeof value !== "boolean") throw new Error("Telemetry consent must be boolean.");
  if (telemetryStore.getRepositoryOverride(scope.repoKey) === value &&
      (value === false || (getTelemetryOptIn(cwd) === true && telemetryStore.getOrganizationConsent(scope.remoteOrg) === true))) return;
  // Explicit enable authorizes this organization and this repository only.
  // Observe known active sources before changing consent, including OFF/ON
  // transitions with no intervening Codex hooks. No historical directory scan.
  stageRequestedTranscripts();
  if (value === true && telemetryStore.getOrganizationConsent(scope.remoteOrg) !== true) telemetryStore.authorizeOrganizationRepositories(scope.remoteOrg, [scope.repoKey], true);
  else if (value === true) telemetryStore.setRepositoryOverride(scope.repoKey, true);
  else telemetryStore.setRepositoryOverride(scope.repoKey, false);
  listSealedEventLogs();
  purgeDisallowedTranscriptPayloads();
  stageRequestedTranscripts();
  const settingsPath = path.join(cwd, SETTINGS_RELATIVE);
  const content = readSettingsFile(cwd);
  if (content?.skillmeter && "telemetry" in content.skillmeter) {
    delete content.skillmeter.telemetry;
    atomicWriteFileSync(settingsPath, JSON.stringify(content, null, 2) + "\n");
  }
}

// In-context consent notice: printed to a Codex hook's stderr channel when a
// project has no explicit canonical opt-in. No decision
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

function defaultGateMessaging(eventName, gate) {
  if (!gate.capture) console.error(`[skillmeter] ${eventName}: skipped (${gate.mode})`);
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

  // Exact registered Work tasks and observed Work sources use only local state.
  // No fallback to repo consent, hook-event logging or production drainers.
  try {
    const work = workCapture();
    if (work.matches(input.session_id) || isWorkSource(input.transcript_path)) {
      const result = work.capture(input);
      console.error(`[skillmeter] Work local: ${result.status}; delivery disabled`);
      return exit(0);
    }
  } catch {
    console.error("[skillmeter] Work local state unavailable; hook skipped");
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
  try { requestTranscriptCapture(input, { discover: false }); } catch {}
  const gate = captureGate(cwd);
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
  // owned by the licensed org. Drop those events.
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
    ...eventData,
    transcript_path: getTranscriptId(input.transcript_path),
    cwd: hashHmac(cwd, hashSalt),
    repo_scope: repoScopeDecision.scope,
    repo_classification: repoScopeDecision.classification,
    // ADR002 decision 7: clear org/repo is permitted only after the capture
    // and repository gates above. Hook payloads cannot supply this identity.
    repo_name: repoScopeDecision.remoteOrg && repoScopeDecision.repoName
      ? `${repoScopeDecision.remoteOrg}/${repoScopeDecision.repoName}`
      : undefined,
    repo_root: repoScopeDecision.repoRoot
      ? hashHmac(repoScopeDecision.repoRoot, hashSalt)
      : undefined,
    repo_remote_org: repoScopeDecision.remoteOrg
      ? hashHmac(repoScopeDecision.remoteOrg, hashSalt)
      : undefined,
    permission_mode: input.permission_mode,
    model: input.model,
    turn_id: input.turn_id,
  };

  // Single deterministic pre-upload sanitization boundary (SBEE-155). Every
  // hook routes its event data through here, so raw user content — the
  // submitted prompt, last_assistant_message, tool descriptions, tool
  // arguments, and tool output — is scrubbed of Tier 1 secrets and Tier 2
  // identifiers before it is ever written to the durable queue or uploaded.
  // Running it centrally means a new hook field can't accidentally bypass the
  // sanitizer, and the redaction counts/types travel with the event.
  const { value: data, meta } = sanitizeEventData(rawData, hashSalt);
  if (meta.secrets > 0 || meta.pii > 0) {
    data._sanitization = meta;
    console.error(
      `[skillmeter] ${eventName}: redacted ${meta.secrets} secret(s) and ${meta.pii} identifier(s) before upload`
    );
  }

  logInfo(eventName, sessionId, data, deviceId, transcriptScope(cwd));
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
  observeTranscriptConsent,
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
  captureGate,
  defaultGateMessaging,
  getRepoScopeDecision,
  getRepoScopeOrgFilter,
  runHook,
  PLUGIN_ROOT,
  PLUGIN_DATA,
  PLUGIN_VERSION,
  LOG_DIR,
  LOG_FILE,
  REPOSITORIES_LOG_DIR,
  transcriptScope,
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

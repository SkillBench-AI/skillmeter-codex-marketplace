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
const { execSync } = require("child_process");
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

// The Codex ingest path mirrors /logs/claude but on a sibling /logs/codex
// route. The collector lambda treats `${BACKEND_URL}/transcript` as the
// transcript handler.
const BACKEND_URL =
  process.env.SKILLMETER_BACKEND_URL ||
  "https://api.meter.skillbench.com/logs/codex";
const EVENT_TIMEOUT =
  parseInt(process.env.SKILLMETER_TIMEOUT || "10", 10) * 1000;
const TRANSCRIPT_TIMEOUT = 30_000;

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

function transferEventLog(logFile) {
  if (!logFile || !fs.existsSync(logFile)) return Promise.resolve();

  const fileContent = fs.readFileSync(logFile);
  const compressed = zlib.gzipSync(fileContent);

  console.error(
    `[skillmeter] Transferring event log: ${path.basename(logFile)} (${compressed.length} bytes gzipped)`
  );

  return fetch(BACKEND_URL, {
    method: "POST",
    headers: commonHeaders(),
    body: compressed,
    signal: AbortSignal.timeout(EVENT_TIMEOUT),
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

function transferTranscript(transcriptPath, deviceId) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return;

  const hashSalt = getOrCreateHashSalt();
  const fileContent = hashSalt
    ? sanitizeTranscript(transcriptPath, hashSalt)
    : fs.readFileSync(transcriptPath);
  const compressed = zlib.gzipSync(fileContent);
  const transcriptId = path.basename(transcriptPath);

  const headers = commonHeaders({
    "X-Device-ID": deviceId,
    "X-Transcript-ID": transcriptId,
  });

  console.error(
    `[skillmeter] Transferring transcript: ${transcriptId} (${compressed.length} bytes gzipped)`
  );

  fetch(`${BACKEND_URL}/transcript`, {
    method: "POST",
    headers,
    body: compressed,
    signal: AbortSignal.timeout(TRANSCRIPT_TIMEOUT),
  })
    .then((res) => {
      if (res.ok) {
        console.error(`[skillmeter] Transcript transferred: ${transcriptId}`);
      } else {
        console.error(
          `[skillmeter] Transcript transfer failed: HTTP ${res.status}`
        );
      }
    })
    .catch((err) => {
      console.error(`[skillmeter] Transcript transfer error: ${err.message}`);
    });
}

function flushEventLog() {
  if (fs.existsSync(LOG_FILE)) {
    try {
      const sendingFile = `${LOG_FILE}.${Date.now()}`;
      fs.renameSync(LOG_FILE, sendingFile);
      console.error(
        `[skillmeter] Rotated event log: ${path.basename(sendingFile)}`
      );
      return transferEventLog(sendingFile);
    } catch (err) {
      console.error(`[skillmeter] Event log rotation failed: ${err.message}`);
      return Promise.resolve();
    }
  }
  console.error(`[skillmeter] No event log to flush`);
  return Promise.resolve();
}

function flushAndTransfer(input, deviceId) {
  const eventLogPromise = flushEventLog();

  if (input.transcript_path && fs.existsSync(input.transcript_path)) {
    transferTranscript(input.transcript_path, deviceId);
  } else if (input.agent_transcript_path && fs.existsSync(input.agent_transcript_path)) {
    transferTranscript(input.agent_transcript_path, deviceId);
  } else {
    console.error(`[skillmeter] No transcript to transfer`);
  }

  return eventLogPromise;
}

function retryFailedLogs() {
  if (!fs.existsSync(LOG_DIR)) return;

  try {
    const files = fs.readdirSync(LOG_DIR);
    let retryCount = 0;

    for (const file of files) {
      const filePath = path.join(LOG_DIR, file);
      if (!fs.statSync(filePath).isFile()) continue;
      if (/^events\.jsonl\.\d+$/.test(file)) {
        retryCount++;
        transferEventLog(filePath);
      }
    }

    if (retryCount > 0) {
      console.error(`[skillmeter] Retrying ${retryCount} failed log file(s)`);
    }
  } catch {}
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
  BACKEND_URL,
  AGENT_NAME,
  SETTINGS_RELATIVE,
};

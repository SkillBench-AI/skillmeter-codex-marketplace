"use strict";

/**
 * Harness detection (SBEE-163, Phase 1 — metadata-only MVP).
 *
 * "Harness" = the scaffolding a developer wraps around their coding agent:
 * instruction files (AGENTS.md / CLAUDE.md), skills, lifecycle hooks, plugins,
 * and higher-level orchestration. Analysis needs to know whether a session was
 * run bare or with a sophisticated harness so it can judge the work fairly.
 *
 * This module produces *presence / shape metadata only* — never raw file
 * contents (see the epic: raw harness content is a higher-risk Phase 4). It is
 * deterministic, filesystem-only, and must never throw: harness detection runs
 * inside the SessionStart hook and a failure here must not break the session,
 * so every probe is wrapped and falls back to a safe "unknown"/empty default.
 *
 * Detection levels (from the work item):
 *   - Level 1 (prompt/filesystem-detectable): instruction-file presence, skills,
 *     hooks, plugin/agent info. Collected here.
 *   - Level 2 (architecture-level, NOT detectable): external orchestration and
 *     multi-agent setups. Emitted as "unknown" until explicit metadata exists.
 *
 * The returned object is plain JSON and is routed through the central
 * sanitizeEventData boundary by the caller before it is logged/uploaded, so any
 * skill/hook name that happens to embed a secret or email is still scrubbed.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { hashHmac } = require("./sanitizer");

// Bump when the shape of the emitted harness metadata changes. Phase 2 routes
// this through the same schema-versioning the rest of the pipeline uses.
const HARNESS_SCHEMA_VERSION = 1;

// Standard lifecycle hook event names. We only ever report event names from
// this allow-list so an arbitrary user-authored hooks.json can't inject
// free-form strings (which could carry project context) into the metadata.
const KNOWN_HOOK_EVENTS = new Set([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "Notification",
]);

// Depth-bounded so a pathological skills tree can't make SessionStart slow.
const SKILL_SCAN_MAX_DEPTH = 4;
// Cap the number of skill names we enumerate; the count is always exact, but
// the name list is bounded so a huge skills library can't bloat the event.
const SKILL_NAMES_LIMIT = 64;

function safeIsFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function safeIsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeReadDir(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Walk up from `startPath` looking for a `.git` marker. Returns "" when the
// path isn't inside a git repo. Mirrors logger.findGitRoot but is kept local so
// harness detection stays self-contained and unit-testable.
function findRepoRoot(startPath) {
  if (!startPath || typeof startPath !== "string") return "";
  let current;
  try {
    current = fs.statSync(startPath).isDirectory()
      ? path.resolve(startPath)
      : path.dirname(path.resolve(startPath));
  } catch {
    return "";
  }
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return "";
    current = parent;
  }
}

// Collect skill directory names (the parent dir of each SKILL.md) under `root`,
// recursing up to SKILL_SCAN_MAX_DEPTH. Hidden namespaces (any path segment
// starting with ".", e.g. the runtime-provided ".system" skills) are skipped so
// the count reflects the developer's own harness rather than built-ins.
function collectSkillNames(root, depth, acc) {
  if (depth > SKILL_SCAN_MAX_DEPTH) return;
  for (const entry of safeReadDir(root)) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const dir = path.join(root, entry.name);
    if (safeIsFile(path.join(dir, "SKILL.md"))) {
      acc.add(entry.name);
    }
    collectSkillNames(dir, depth + 1, acc);
  }
}

function detectSkills(roots) {
  const names = new Set();
  const scopes = new Set();
  for (const { scope, dir } of roots) {
    if (!safeIsDir(dir)) continue;
    const before = names.size;
    collectSkillNames(dir, 1, names);
    if (names.size > before) scopes.add(scope);
  }
  return { names: [...names].sort(), scopes: [...scopes].sort() };
}

// Read the hook event names declared in a hooks.json file. Only names on the
// known-events allow-list survive, so we never echo arbitrary user strings.
function readHookEvents(hooksJsonPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(hooksJsonPath, "utf8"));
    const hooks = parsed && parsed.hooks;
    if (!hooks || typeof hooks !== "object") return [];
    return Object.keys(hooks).filter((event) => KNOWN_HOOK_EVENTS.has(event));
  } catch {
    return [];
  }
}

function detectHooks(sources) {
  const enabled = new Set();
  const scopes = new Set();
  for (const { scope, file } of sources) {
    if (!safeIsFile(file)) continue;
    const events = readHookEvents(file);
    if (events.length === 0) continue;
    for (const event of events) enabled.add(event);
    scopes.add(scope);
  }
  return { enabled: [...enabled].sort(), scopes: [...scopes].sort() };
}

/**
 * Detect Level 1 harness metadata for a session running in `cwd`.
 *
 * @param {string} cwd - session working directory (unhashed; only used to probe
 *   the filesystem — never emitted).
 * @param {object} [options]
 * @param {string} [options.repoRoot] - precomputed git root (avoids a re-walk);
 *   derived from `cwd` when omitted.
 * @param {string} [options.homeDir] - overrides os.homedir() (test seam).
 * @param {string} [options.pluginRoot] - this plugin's root, for its hooks.json.
 * @param {string} [options.pluginVersion] - this plugin's version.
 * @param {string} [options.agentType] - agent label (defaults to "codex").
 * @param {string} [options.hashSalt] - per-machine HMAC salt; required to hash
 *   skill names.
 * @param {boolean} [options.hashSkillNames] - when true, emit `names_hashed`
 *   (HMAC) instead of plaintext `names`. Defaults from
 *   SKILLMETER_HARNESS_HASH_SKILL_NAMES.
 * @returns {object} plain-JSON harness metadata (safe to route through the
 *   sanitizer and upload).
 */
function detectHarness(cwd, options = {}) {
  const base = {
    schema_version: HARNESS_SCHEMA_VERSION,
    agent_type: options.agentType || "codex",
    instructions: { has_agents_md: false, has_claude_md: false, scopes: [] },
    skills: { count: 0, names: [], scopes: [] },
    hooks: { enabled: [], scopes: [] },
    // Level 2 — architecture-level signals are not detectable from the
    // filesystem/transcript, so they are explicitly "unknown" rather than a
    // misleading false. subagent_used is derived downstream from the
    // SubagentStart/SubagentStop events the collector already emits.
    orchestration: {
      external_orchestration: "unknown",
      multi_agent: "unknown",
    },
  };

  try {
    if (options.pluginVersion) {
      base.plugin = { name: "skillmeter", version: options.pluginVersion };
    }

    const homeDir = options.homeDir || os.homedir();
    const repoRoot =
      options.repoRoot !== undefined ? options.repoRoot : findRepoRoot(cwd);

    // ---- Instruction files (AGENTS.md / CLAUDE.md) ----
    // Project-scope = cwd or repo root; global-scope = ~/.codex (AGENTS.md) and
    // ~/.claude (CLAUDE.md). Codex reads AGENTS.md; CLAUDE.md is tracked too so
    // cross-agent harnesses are visible.
    const instrScopes = new Set();
    const projectDirs = [cwd, repoRoot].filter(Boolean);

    const hasProjectFile = (name) =>
      projectDirs.some((dir) => safeIsFile(path.join(dir, name)));

    const agentsProject = hasProjectFile("AGENTS.md");
    const claudeProject = hasProjectFile("CLAUDE.md");
    const agentsGlobal =
      !!homeDir && safeIsFile(path.join(homeDir, ".codex", "AGENTS.md"));
    const claudeGlobal =
      !!homeDir && safeIsFile(path.join(homeDir, ".claude", "CLAUDE.md"));

    if (agentsProject || claudeProject) instrScopes.add("project");
    if (agentsGlobal || claudeGlobal) instrScopes.add("global");

    base.instructions.has_agents_md = agentsProject;
    base.instructions.has_agents_md_global = agentsGlobal;
    base.instructions.has_claude_md = claudeProject;
    base.instructions.has_claude_md_global = claudeGlobal;
    base.instructions.scopes = [...instrScopes].sort();

    // ---- Skills ----
    const skillRoots = [];
    if (repoRoot) skillRoots.push({ scope: "project", dir: path.join(repoRoot, ".codex", "skills") });
    if (cwd && cwd !== repoRoot) skillRoots.push({ scope: "project", dir: path.join(cwd, ".codex", "skills") });
    if (homeDir) skillRoots.push({ scope: "global", dir: path.join(homeDir, ".codex", "skills") });

    const { names: skillNames, scopes: skillScopes } = detectSkills(skillRoots);
    base.skills.count = skillNames.length;
    base.skills.scopes = skillScopes;

    const hashNames =
      options.hashSkillNames !== undefined
        ? options.hashSkillNames
        : process.env.SKILLMETER_HARNESS_HASH_SKILL_NAMES === "1";
    const limited = skillNames.slice(0, SKILL_NAMES_LIMIT);
    if (hashNames && options.hashSalt) {
      delete base.skills.names;
      base.skills.names_hashed = limited.map((n) => hashHmac(n, options.hashSalt));
    } else {
      base.skills.names = limited;
    }
    if (skillNames.length > limited.length) {
      base.skills.names_truncated = true;
    }

    // ---- Hooks ----
    const hookSources = [];
    if (options.pluginRoot) {
      hookSources.push({
        scope: "plugin",
        file: path.join(options.pluginRoot, "hooks", "hooks.json"),
      });
    }
    if (repoRoot) hookSources.push({ scope: "project", file: path.join(repoRoot, ".codex", "hooks.json") });
    if (cwd && cwd !== repoRoot) hookSources.push({ scope: "project", file: path.join(cwd, ".codex", "hooks.json") });
    if (homeDir) hookSources.push({ scope: "global", file: path.join(homeDir, ".codex", "hooks.json") });

    const { enabled, scopes: hookScopes } = detectHooks(hookSources);
    base.hooks.enabled = enabled;
    base.hooks.scopes = hookScopes;
  } catch {
    // Any unexpected failure leaves the safe defaults in place — never throw
    // out of the SessionStart hook.
  }

  return base;
}

module.exports = {
  HARNESS_SCHEMA_VERSION,
  KNOWN_HOOK_EVENTS,
  detectHarness,
  findRepoRoot,
};

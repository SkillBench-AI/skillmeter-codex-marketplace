"use strict";
/**
 * Local repositories of the licensed organizations, for sign-in onboarding.
 * Discovery reads the working directory, Codex's trusted projects and the
 * `cwd` of each rollout's `session_meta`. The public result carries repository
 * keys and display names only, never local paths.
 */

const fs = require("fs");
const path = require("path");
const { normalizeRepoKey } = require("./consent-store");

const ROLLOUT_RE = /^rollout-.*\.jsonl$/;
// session_meta can carry long instructions; stop looking for its line end here.
const FIRST_LINE_LIMIT = 1024 * 1024;

function entries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
}

function rolloutFiles(dir, out = []) {
  for (const entry of entries(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) rolloutFiles(full, out);
    else if (entry.isFile() && ROLLOUT_RE.test(entry.name)) out.push(full);
  }
  return out;
}

function firstLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const chunks = [];
    const buffer = Buffer.alloc(64 * 1024);
    for (let total = 0; total < FIRST_LINE_LIMIT;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, total);
      if (read === 0) break;
      const end = buffer.subarray(0, read).indexOf(10);
      chunks.push(Buffer.from(buffer.subarray(0, end === -1 ? read : end)));
      if (end !== -1) return Buffer.concat(chunks).toString("utf8");
      total += read;
    }
    return "";
  } catch { return ""; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function rolloutCwd(file) {
  try {
    const record = JSON.parse(firstLine(file));
    const cwd = record?.type === "session_meta" ? record.payload?.cwd : null;
    return typeof cwd === "string" && path.isAbsolute(cwd) ? cwd : null;
  } catch { return null; }
}

// `[projects."<path>"]` tables in config.toml. A full TOML parser is not
// needed for these headers.
function trustedProjectCwds(configFile) {
  let text;
  try { text = fs.readFileSync(configFile, "utf8"); }
  catch { return []; }
  const cwds = [];
  for (const match of text.matchAll(/^\s*\[projects\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\]\s*$/gm)) {
    const value = match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2];
    if (path.isAbsolute(value)) cwds.push(value);
  }
  return cwds;
}

function discoverRepositoryRoots({ codexHome, currentCwd, findGitRoot }) {
  const roots = new Set();
  const seen = new Set();
  const add = cwd => {
    if (!cwd || seen.has(cwd)) return;
    seen.add(cwd);
    let root = "";
    try { root = findGitRoot(cwd) || ""; } catch {}
    if (!root) return;
    try { root = fs.realpathSync.native(root); } catch { return; }
    roots.add(root);
  };
  add(currentCwd);
  for (const cwd of trustedProjectCwds(path.join(codexHome, "config.toml"))) add(cwd);
  for (const dir of ["sessions", "archived_sessions"]) {
    for (const file of rolloutFiles(path.join(codexHome, dir))) add(rolloutCwd(file));
  }
  return [...roots].sort();
}

// A choice counts as ON only when it carries the Codex scope acknowledgement.
function choice(record) {
  if (!record || typeof record.enabled !== "boolean") return null;
  if (!record.enabled) return false;
  return record.consent_version === 2 ? true : null;
}

/**
 * @param {object} options
 * @param {string[]} options.roots discovered checkout roots
 * @param {string[]} options.allowedOrgs licensed organizations after scope filters
 * @param {object|null} options.policy Codex consent record, or null when absent
 * @param {(root: string) => object} options.getScope repository scope decision
 * @param {(root: string) => string} options.getLocalChoice local setting of a checkout
 * @param {boolean} options.globalPaused
 */
function buildInventory({ roots, allowedOrgs, policy, getScope, getLocalChoice, globalPaused }) {
  const allowed = new Set(allowedOrgs);
  const repositories = new Map();
  const add = (key, restricted) => {
    const [, org, name] = key.split("/");
    const current = repositories.get(key);
    if (current) { current.localRestriction ||= restricted; return; }
    repositories.set(key, { key, org, displayName: `@${org}/${name}`, localRestriction: restricted });
  };

  for (const root of roots) {
    let scope;
    try { scope = getScope(root); } catch { continue; }
    if (!scope?.allowed || !scope.repoKey || !allowed.has(scope.remoteOrg)) continue;
    let local = "invalid";
    try { local = getLocalChoice(root); } catch {}
    add(scope.repoKey, local === "off" || local === "invalid");
  }
  // Keep recorded choices visible after their checkout is gone, as the Claude
  // plugin does, so a decision is never hidden by discovery.
  for (const raw of Object.keys(policy?.repositories || {})) {
    const key = normalizeRepoKey(raw);
    if (key && allowed.has(key.split("/")[1])) add(key, false);
  }

  const organizations = policy?.organizations || {};
  const list = [...repositories.values()].map(repo => {
    const consent = choice(policy?.repositories?.[repo.key]);
    const orgConsent = choice(organizations[repo.org]);
    const on = !globalPaused && orgConsent === true && consent === true && !repo.localRestriction;
    return { ...repo, consent, effective: on ? "on" : "off" };
  }).sort((a, b) => a.displayName.localeCompare(b.displayName));

  return {
    revision: policy ? policy.revision : "absent",
    globalPaused,
    orgs: [...allowed].sort().map(org => ({ org, consent: choice(organizations[org]) })),
    repositories: list,
  };
}

// Reads the current license, scope filters and Codex consent record. Throws the
// store's error when the record is unreadable or missing after it was seen:
// choices are never offered over it. `discover: false` skips the local scan.
function loadInventory({ cwd = process.cwd(), discover = true } = {}) {
  const logger = require("../logger.js");
  const credstore = require("../credstore.js");
  const { createConsentStore } = require("./consent-store");
  const { consentPolicyFile } = require("./consent-policy");
  credstore.refreshFromDisk();
  const store = createConsentStore({ file: consentPolicyFile(), observedFile: logger.CONSENT_OBSERVED_FILE });
  const policy = store.readPolicy();
  const filter = logger.getRepoScopeOrgFilter(cwd);
  const inventory = buildInventory({
    roots: discover ? discoverRepositoryRoots({ codexHome: logger.CODEX_HOME, currentCwd: cwd, findGitRoot: logger.findGitRoot }) : [],
    allowedOrgs: credstore.getAllowedGitHubOrgs().filter(org => !filter || filter.includes(org)),
    policy,
    getScope: logger.getRepoScopeDecision,
    getLocalChoice: logger.getLocalTelemetryChoice,
    globalPaused: policy ? !policy.global.enabled : false,
  });
  return { store, inventory, logger };
}

module.exports = { discoverRepositoryRoots, buildInventory, loadInventory, trustedProjectCwds, rolloutCwd };

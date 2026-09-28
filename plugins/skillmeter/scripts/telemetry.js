#!/usr/bin/env node
/**
 * Codex consent controls: organization and repository choices and the global
 * pause in Codex's consent record, and local restrictions in
 * .codex/settings.local.json.
 * Usage: node scripts/telemetry.js <enable|disable> [--global], status [--details],
 * or node scripts/telemetry.js consent-preview [--json]; consent-set --help prints choice arguments.
 */

const {
  getTelemetryOptIn,
  getLocalTelemetryChoice,
  readSharedGlobalPolicy,
  getTelemetryGloballyDisabled,
  saveTelemetryOptIn,
  setTelemetryGloballyDisabled,
  SETTINGS_RELATIVE,
  getRepoScopeDecision,
  getRepositoryPolicyDecision,
  resolveTelemetryGate,
  isLicenseRejected,
  listPendingTranscripts,
  LOG_DIR,
  LOG_FILE,
  CONSENT_OBSERVED_FILE,
  getRepoScopeOrgFilter,
  findGitRoot,
} = require("./logger.js");
const {
  getLicenseToken,
  isEventCutoverComplete,
  isLicenseTokenExpired,
  getSignedOut,
  getAllowedGitHubOrgs,
  refreshFromDisk,
} = require("./credstore.js");

const fs = require("fs");
const path = require("path");
const { isJwtExpired } = require("./lib/jwt");
const licenseActivation = require("./lib/license-activation");
const { inventory } = require("./transcript_inventory");
const { consentPolicyFile } = require("./lib/shared-telemetry-policy");

const cwd = process.cwd();
const projectRoot = findGitRoot(cwd) || cwd;
const action = process.argv[2];
const isGlobal = process.argv.slice(3).includes("--global");

function authenticationLine() {
  if (!isEventCutoverComplete()) return "upgrade held; event queue cutover incomplete; close older sessions and retry; preserve the queue if the hold persists";
  if (getSignedOut()) return "signed out; run the signin skill";
  const terminal = licenseActivation.readStatus().terminal;
  if (terminal?.reason === licenseActivation.TERMINAL.REVOKED) {
    return "the workspace no longer licenses you; run the signin skill with a workspace that does";
  }
  const token = getLicenseToken();
  if (!token) return "not signed in; run the signin skill";
  if (terminal) return "the sign-in session ended; run the signin skill";
  if (isLicenseRejected()) return "paused; server rejected the license, renewal due";
  if (isJwtExpired(token)) return "paused; license expired, renewal due";
  if (isLicenseTokenExpired(token)) return "renewal due; license still within the upload validity window";
  return "license locally valid; server acceptance not verified";
}

// The global pause is in Codex's consent record; a concurrent change is
// reported rather than overwritten.
function setGlobalPause(paused) {
  try {
    setTelemetryGloballyDisabled(paused);
    return true;
  } catch (error) {
    process.stderr.write(`SkillMeter: ${error.code || "PAUSE_UPDATE_FAILED"}: ${error.message}\n`);
    process.exitCode = 1;
    return false;
  }
}

function sharedPauseLine() {
  const policy = readSharedGlobalPolicy();
  if (policy.reason === "missing") return "paused; previously observed consent record is missing; restore it before capture or delivery";
  if (policy.errorCode === "POLICY_OBSERVATION_FAILED") return "paused; consent record observation unavailable; check plugin data permissions";
  if (policy.reason === "invalid") return "consent record invalid or unreadable; capture and delivery paused; repair the record";
  if (policy.disabled) return "globally paused for Codex on this machine; resume with enable --global";
  return null;
}

// `state` picks the status card; `text` is the detailed capture policy line.
function captureState() {
  const result = (state, text) => ({ state, text });
  const shared = sharedPauseLine();
  if (shared) return result("paused", shared);
  if (getTelemetryGloballyDisabled()) return result("paused", "globally disabled");
  const scope = getRepoScopeDecision(cwd);
  const sharedRepository = getRepositoryPolicyDecision(cwd);
  if (sharedRepository.reason === "shared_policy_missing") return result("paused", "paused; previously observed consent record is missing");
  if (scope.allowed && sharedRepository.revoked) return result("off", "disabled by the organization or repository choice");
  if (scope.allowed && sharedRepository.reason === "absent") return result("consent", "disabled; organization and repository consent required (run consent-preview)");
  if (scope.allowed && !sharedRepository.allowed) return result("consent", "disabled; organization and repository choices must both be recorded and enabled");
  const gate = resolveTelemetryGate(getTelemetryOptIn(cwd), scope.allowed);
  if (gate.mode === "opted_out") return result("off", "disabled for this project");
  if (!scope.allowed) return result(scope.classification === "not_activated" ? "signin" : "scope", `excluded (${scope.classification})`);
  if (getLocalTelemetryChoice(cwd) === "invalid") return result("paused", "paused; invalid local consent settings; repair them before capture");
  if (!gate.capture) return result("consent", "disabled; organization and repository ON must be recorded with the scope acknowledgement");
  return result("on", "eligible for this repository; hook execution not verified");
}

function capturePolicyLine() {
  return captureState().text;
}

function queueCounts() {
  let entries = [];
  try { entries = fs.readdirSync(LOG_DIR); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const batches = entries.filter(name => /^events\.jsonl\.\d+$/.test(name) && fs.statSync(path.join(LOG_DIR, name)).isFile()).length;
  let active = false;
  try { active = fs.statSync(LOG_FILE).size > 0; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return { batches, chunks: listPendingTranscripts().length, active };
}

function queueLines() {
  try {
    const { batches, chunks, active } = queueCounts();
    return [
      `Upload queue (all repositories): ${batches} sealed event ${batches === 1 ? "batch" : "batches"}, ${chunks} transcript chunks`,
      `Unsealed event data: ${active ? "present" : "none"}`,
    ];
  } catch {
    return ["Upload queue: unavailable; could not read local queue state"];
  }
}

function queueSummary() {
  try {
    const { batches, chunks } = queueCounts();
    return `${batches} event ${batches === 1 ? "batch" : "batches"} · ${chunks} transcript ${chunks === 1 ? "chunk" : "chunks"} pending`;
  } catch { return "unavailable"; }
}

// The card shows the repository as org/repo and sign-in as OK when nothing
// stands in the way; anything else keeps the detailed text.
function statusCard() {
  const { statusBanner } = require("./lib/banner");
  const scope = getRepoScopeDecision(cwd);
  const auth = authenticationLine();
  return statusBanner({
    capture: captureState(),
    repository: scope.repoKey ? scope.repoKey.replace(/^github\.com\//, "") : null,
    signIn: auth.startsWith("license locally valid") ? "OK" : auth,
    queue: queueSummary(),
  });
}

function transcriptHealthLines() {
  try {
    const state = inventory(path.dirname(LOG_DIR));
    const blocked = state.sessions.filter(s => s.failures.some(f => f.phase === "capture"));
    const observed = state.sessions.filter(s => s.capture && !s.capture.unreadable &&
      Number.isSafeInteger(s.capture.observedBytes) && Number.isSafeInteger(s.capture.capturedBytes));
    const behind = observed.filter(s => s.capture.observedBytes > s.capture.capturedBytes);
    const progress = observed.map(s => s.capture.lastProgressAt).filter(Boolean).sort();
    const acknowledgments = state.sessions.map(s => s.delivery?.lastSuccessAt).filter(Boolean).sort();
    const failures = Object.entries(state.chunkDiagnostics).map(([code, count]) => `${code}: ${count}`).join(", ");
    return [
      `Transcript capture (all repositories): ${blocked.length} blocked, ${behind.length} behind last observed source size, ${state.sessions.length - observed.length} without progress observations`,
      `Last transcript capture progress: ${progress.at(-1) || "unknown"}; observations are not a live source inventory`,
      `Transcript diagnostics: ${failures || "none recorded; hook execution and source discovery not verified"}`,
      `Last transcript HTTP acknowledgment: ${acknowledgments.at(-1) || "unknown"}; storage completeness not verified`,
      "Downstream analysis and report delivery: unknown",
    ];
  } catch { return ["Transcript capture health: unavailable; local state could not be read"]; }
}

function saveRepositoryChoice(value) {
  try {
    saveTelemetryOptIn(cwd, value);
    return true;
  } catch (error) {
    if (error.message === "repository-routing-busy") {
      process.stderr.write("SkillMeter: Repository controls are busy; retry this command.\n");
    } else {
      process.stderr.write(`SkillMeter: Could not update ${SETTINGS_RELATIVE}; check local routing state, JSON and file permissions.\n`);
    }
    process.exitCode = 1;
    return false;
  }
}

switch (action) {
  case "consent-preview": {
    refreshFromDisk();
    const { createSharedPolicyStore } = require("./lib/shared-policy-store");
    const { buildConsentPreview, formatConsentPreview } = require("./lib/shared-consent-preview");
    const store = createSharedPolicyStore({ file: consentPolicyFile(), observedFile: CONSENT_OBSERVED_FILE });
    let policy = null, policyError = null;
    try { policy = store.readPolicy(); }
    catch (error) { policyError = { code: error.code || "POLICY_UNAVAILABLE", message: error.message }; }
    const result = buildConsentPreview({ cwd, repoRoot: findGitRoot(cwd), scope: getRepoScopeDecision(cwd), policy, policyError });
    process.stdout.write(process.argv.includes("--json") ? JSON.stringify(result) + "\n" : formatConsentPreview(result));
    break;
  }
  case "consent-set": {
    refreshFromDisk();
    const { createSharedPolicyStore } = require("./lib/shared-policy-store");
    const { applyOrganizationConsent, applyRepositoryConsent, parseConsentChoiceArgs, CONSENT_SET_USAGE } = require("./lib/shared-consent-apply");
    try {
      const options = parseConsentChoiceArgs(process.argv.slice(3));
      if (options.help) { process.stdout.write(`${CONSENT_SET_USAGE}\n`); break; }
      const store = createSharedPolicyStore({ file: consentPolicyFile(), observedFile: CONSENT_OBSERVED_FILE });
      const { reconcileSharedRevocations, observeKnownTranscriptConsent } = require("./logger.js");
      let cleaned = false;
      const onCommitted = () => {
        // Observe the saved choice before releasing the writer lock. Cleanup
        // failures cannot roll back consent or authorize an upload.
        try { cleaned = reconcileSharedRevocations(); observeKnownTranscriptConsent(); }
        catch { cleaned = false; }
      };
      let policy;
      if (options.organization !== undefined) {
        const filter = getRepoScopeOrgFilter(cwd);
        const allowedOrgs = getAllowedGitHubOrgs().filter(org => !filter || filter.includes(org));
        policy = applyOrganizationConsent({ store, allowedOrgs, ...options, onCommitted });
      } else {
        policy = applyRepositoryConsent({ cwd, scope: getRepoScopeDecision(cwd), store, ...options, onCommitted });
      }
      const { consentSavedBanner } = require("./lib/banner");
      const isOrganization = options.organization !== undefined;
      process.stdout.write(consentSavedBanner({
        kind: isOrganization ? "organization" : "repository",
        target: isOrganization ? `@${options.organization.trim().toLowerCase()}` : options.repository.replace(/^github\.com\//, ""),
        enabled: options.enabled,
        revision: policy.revision,
        capture: captureState(),
        cleanupDeferred: !cleaned,
        durabilityUnconfirmed: policy.durability === "unconfirmed",
      }));
    } catch (error) {
      process.stderr.write(`SkillMeter: ${error.code || "CONSENT_UPDATE_FAILED"}: ${error.message}\n`);
      process.exitCode = 1;
    }
    break;
  }
  case "enable":
    if (isGlobal) {
      if (!setGlobalPause(false)) break;
      const shared = sharedPauseLine();
      process.stderr.write(shared ? `SkillMeter: Global pause cleared, but ${shared}\n` : "SkillMeter: Telemetry resumed for Codex on this machine\n");
    } else {
      if (!saveRepositoryChoice(true)) break;
      process.stderr.write(`SkillMeter: Local restriction cleared for ${projectRoot}\n`);
      process.stderr.write(`           (saved to ${SETTINGS_RELATIVE}; capture also needs organization and repository consent)\n`);
      if (getTelemetryOptIn(cwd) !== true) {
        process.stderr.write(`SkillMeter: Capture remains blocked: ${capturePolicyLine()}\n`);
      }
      if (getTelemetryGloballyDisabled()) process.stderr.write(`SkillMeter: ${sharedPauseLine()}\n`);
    }
    break;
  case "disable":
    if (isGlobal) {
      if (!setGlobalPause(true)) break;
      process.stderr.write("SkillMeter: Telemetry paused for Codex on this machine\n");
      process.stderr.write("SkillMeter: Pending uploads will remain queued until telemetry is resumed\n");
    } else {
      if (!saveRepositoryChoice(false)) break;
      process.stderr.write(`SkillMeter: New capture disabled for ${projectRoot}; queued repository payloads revoked (in-flight requests may finish)\n`);
    }
    break;
  case "status": {
    // Status reads state only; it never changes the session or consent record.
    refreshFromDisk();
    if (!process.argv.includes("--details")) {
      process.stderr.write(statusCard());
      break;
    }
    const lines = [
      `Capture policy: ${capturePolicyLine()}`,
      `Delivery authentication: ${authenticationLine()}`,
      ...queueLines(),
      ...transcriptHealthLines(),
      "Last successful event upload: unknown (not tracked by this version)",
      "An empty queue does not prove delivery or report generation.",
    ];
    for (const line of lines) process.stderr.write(`SkillMeter: ${line}\n`);
    break;
  }
  default:
    process.stderr.write("Usage: node telemetry.js <enable|disable> [--global] | status [--details] | consent-preview [--json] | consent-set <on|off> (--organization <org> | --repository <key>) --revision <number|absent> [--acknowledge-machine-scope]\n");
    process.exit(1);
}

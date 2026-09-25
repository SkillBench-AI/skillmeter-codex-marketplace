#!/usr/bin/env node
/**
 * Set project consent in .codex/settings.local.json or the shared global pause.
 * Usage: node scripts/telemetry.js <enable|disable|status> [--global],
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
  findGitRoot,
} = require("./logger.js");
const {
  getLicenseToken,
  isLicenseTokenExpired,
  getSignedOut,
  refreshFromDisk,
} = require("./credstore.js");

const fs = require("fs");
const path = require("path");
const { isJwtExpired } = require("./lib/jwt");
const { sharedPolicyFile } = require("./lib/shared-telemetry-policy");

const cwd = process.cwd();
const projectRoot = findGitRoot(cwd) || cwd;
const action = process.argv[2];
const isGlobal = process.argv.slice(3).includes("--global");

function authenticationLine() {
  if (getSignedOut()) return "signed out; run the signin skill";
  const token = getLicenseToken();
  if (!token) return "no license; run the signin skill";
  if (isLicenseRejected()) return "paused; server rejected license, refresh required";
  if (isJwtExpired(token)) return "paused; license expired or invalid, refresh required";
  if (isLicenseTokenExpired(token)) return "refresh due; license still within the upload validity window";
  return "license locally valid; server acceptance not verified";
}

function sharedPauseLine() {
  const policy = readSharedGlobalPolicy();
  if (policy.reason === "missing") return "paused; previously observed shared policy is missing; restore it before capture or delivery";
  if (policy.errorCode === "POLICY_OBSERVATION_FAILED") return "paused; shared policy observation unavailable; check client data permissions";
  if (policy.reason === "invalid") return "shared policy invalid or unreadable; capture and delivery paused; repair the policy file";
  if (policy.disabled) return "shared policy paused; resume global telemetry through the shared policy controls";
  return null;
}

function capturePolicyLine() {
  const shared = sharedPauseLine();
  if (shared) return shared;
  if (getTelemetryGloballyDisabled()) return "globally disabled";
  const scope = getRepoScopeDecision(cwd);
  const sharedRepository = getRepositoryPolicyDecision(cwd);
  if (sharedRepository.reason === "shared_policy_missing") return "paused; previously observed shared policy is missing";
  if (sharedRepository.reason === "routing_unavailable") return "paused; repository routing unavailable";
  if (scope.allowed && sharedRepository.revoked) return "disabled by shared organization or repository policy";
  if (scope.allowed && !sharedRepository.allowed) return "paused; shared organization and repository choices must be valid and enabled";
  const gate = resolveTelemetryGate(getTelemetryOptIn(cwd), scope.allowed);
  if (gate.mode === "opted_out") return "disabled for this project";
  if (!scope.allowed) return `excluded (${scope.classification})`;
  if (getLocalTelemetryChoice(cwd) === "invalid") return "paused; invalid local consent settings; repair them before capture";
  if (!gate.capture && sharedRepository.reason === "enabled" && !sharedRepository.acknowledged) return "disabled; machine-wide acknowledgement required or legacy local opt-in";
  if (!gate.capture) return "disabled; repository choice required";
  if (sharedRepository.acknowledged) return "eligible through acknowledged shared consent; hook execution not verified";
  if (sharedRepository.reason === "enabled") return "eligible through legacy local opt-in; shared scope acknowledgement pending; hook execution not verified";
  return "eligible for this repository; hook execution not verified";
}

function queueLines() {
  try {
    let entries = [];
    try { entries = fs.readdirSync(LOG_DIR); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const batches = entries.filter(name => /^events\.jsonl\.\d+$/.test(name) && fs.statSync(path.join(LOG_DIR, name)).isFile()).length;
    const chunks = listPendingTranscripts().length;
    let active = false;
    try { active = fs.statSync(LOG_FILE).size > 0; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return [
      `Upload queue (all repositories): ${batches} sealed event ${batches === 1 ? "batch" : "batches"}, ${chunks} transcript chunks`,
      `Unsealed event data: ${active ? "present" : "none"}`,
    ];
  } catch {
    return ["Upload queue: unavailable; could not read local queue state"];
  }
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
    const store = createSharedPolicyStore({
      file: sharedPolicyFile(), observedFile: path.join(LOG_DIR, "shared-policy-observed"),
    });
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
    const { applyRepositoryConsent, parseConsentChoiceArgs } = require("./lib/shared-consent-apply");
    try {
      const options = parseConsentChoiceArgs(process.argv.slice(3));
      const store = createSharedPolicyStore({ file: sharedPolicyFile(), observedFile: path.join(LOG_DIR, "shared-policy-observed") });
      const { reconcileSharedRevocations, observeKnownTranscriptConsent } = require("./logger.js");
      let cleaned = false;
      const policy = applyRepositoryConsent({ cwd, scope: getRepoScopeDecision(cwd), store, ...options,
        onCommitted: () => {
          // Observe the saved choice before releasing the shared writer lock.
          // Cleanup failures cannot roll back consent or authorize an upload.
          try { cleaned = reconcileSharedRevocations(); observeKnownTranscriptConsent(); }
          catch { cleaned = false; }
        },
      });
      process.stdout.write(`Shared repository choice saved: ${options.enabled ? "ON" : "OFF"} (revision ${policy.revision}).\n`);
      process.stdout.write(cleaned ? "Known local queue revocations checked.\n" : "Some local queue cleanup is deferred; delivery still rechecks consent.\n");
      process.stdout.write("Local restrictions are unchanged. Acknowledged shared consent can authorize capture; authentication, shared pause and other restrictions still apply.\n");
      process.stdout.write("This does not verify hook execution, delivery or report generation.\n");
    } catch (error) {
      process.stderr.write(`SkillMeter: ${error.code || "CONSENT_UPDATE_FAILED"}: ${error.message}\n`);
      process.exitCode = 1;
    }
    break;
  }
  case "enable":
    if (isGlobal) {
      setTelemetryGloballyDisabled(false);
      const shared = sharedPauseLine();
      process.stderr.write(shared ? `SkillMeter: Local pause cleared; ${shared}\n` : "SkillMeter: Global telemetry uploads enabled for this machine\n");
    } else {
      if (!saveRepositoryChoice(true)) break;
      process.stderr.write(`SkillMeter: Repository choice saved for ${projectRoot}\n`);
      process.stderr.write(`           (saved to ${SETTINGS_RELATIVE}; scope and global pause still apply)\n`);
      if (getTelemetryOptIn(cwd) !== true) {
        process.stderr.write(`SkillMeter: Capture remains blocked: ${capturePolicyLine()}\n`);
      }
      if (getTelemetryGloballyDisabled()) {
        process.stderr.write(
          sharedPauseLine() ? `SkillMeter: ${sharedPauseLine()}\n` :
          "SkillMeter: Global telemetry is still disabled; run with --global to resume uploads\n"
        );
      }
    }
    break;
  case "disable":
    if (isGlobal) {
      setTelemetryGloballyDisabled(true);
      process.stderr.write("SkillMeter: Global telemetry uploads disabled for this machine\n");
      process.stderr.write("SkillMeter: Pending uploads will remain queued until global telemetry is enabled\n");
    } else {
      if (!saveRepositoryChoice(false)) break;
      process.stderr.write(`SkillMeter: New capture disabled for ${projectRoot}; queued repository payloads revoked (in-flight requests may finish)\n`);
    }
    break;
  case "status": {
    // Status must not migrate credentials from Keychain or change shared state.
    refreshFromDisk();
    const lines = [
      `Capture policy: ${capturePolicyLine()}`,
      `Delivery authentication: ${authenticationLine()}`,
      ...queueLines(),
      "Last successful upload: unknown (not tracked by this version)",
      "An empty queue does not prove delivery or report generation.",
    ];
    for (const line of lines) process.stderr.write(`SkillMeter: ${line}\n`);
    break;
  }
  default:
    process.stderr.write("Usage: node telemetry.js <enable|disable|status> [--global] | consent-preview [--json] | consent-set <on|off> --repository <key> --revision <number|absent> [--acknowledge-machine-scope]\n");
    process.exit(1);
}

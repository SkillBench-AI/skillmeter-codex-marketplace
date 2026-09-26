"use strict";
const { buildConsentPreview } = require("./shared-consent-preview");
const error = (code, message) => Object.assign(new Error(message), { code });

const CONSENT_SET_USAGE = "Usage: consent-set <on|off> --repository github.com/org/repo --revision <number|absent> [--acknowledge-machine-scope]";

function parseConsentChoiceArgs(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const fail = () => { throw error("INVALID_ARGUMENTS", CONSENT_SET_USAGE); };
  if (!["on", "off"].includes(args[0])) fail();
  const options = { enabled: args[0] === "on", acknowledged: false };
  const seen = new Set();
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) fail();
    seen.add(arg);
    if (arg === "--acknowledge-machine-scope") options.acknowledged = true;
    else if (arg === "--repository") options.repository = args[++i];
    else if (arg === "--revision") {
      const value = args[++i];
      if (value !== "absent" && !/^(0|[1-9][0-9]*)$/.test(value || "")) fail();
      options.expectedRevision = value === "absent" ? null : Number(value);
    } else fail();
  }
  if (!options.repository || !seen.has("--revision")) fail();
  return options;
}

function applyRepositoryConsent({ cwd, scope, store, repository, expectedRevision, enabled, acknowledged, onCommitted }) {
  if (typeof enabled !== "boolean") throw error("CHOICE_REQUIRED", "Choose ON or OFF explicitly; a local choice is never migrated automatically.");
  if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    throw error("EXPECTED_REVISION_REQUIRED", "Run consent-preview and supply its shared revision, or absent for first use.");
  }
  if (!scope.allowed || !scope.repoKey) throw error("REPOSITORY_UNAVAILABLE", "No allowed canonical repository is available; check sign-in, organization scope and Git remotes.");
  if (repository !== scope.repoKey) throw error("REPOSITORY_CHANGED", "Repository differs from the preview; run consent-preview here and confirm again.");
  if (enabled && acknowledged !== true) {
    throw error("ACKNOWLEDGEMENT_REQUIRED", "ON authorizes every supported SkillMeter client and every clone or worktree of this repository on this machine. Review consent-preview, then pass --acknowledge-machine-scope to confirm.");
  }
  const policy = store.readPolicy();
  if ((policy?.revision ?? null) !== expectedRevision) throw error("STALE_POLICY", "Shared policy changed; run consent-preview and confirm the current choices again.");
  if (enabled) {
    const preview = buildConsentPreview({ cwd, scope, policy });
    if (preview.localChoices.some(choice => ["off", "invalid"].includes(choice.choice))) {
      throw error("LOCAL_CONSENT_CONFLICT", "Local OFF or invalid settings remain a restriction. Inspect consent-preview and resolve them explicitly before enabling shared consent.");
    }
    const org = repository.split("/")[1];
    const choice = policy?.organizations?.[org];
    if (choice?.enabled !== true || choice.consent_version !== 2) {
      throw error("ORGANIZATION_CONSENT_REQUIRED", "Machine-wide organization authorization is required first. This command does not authorize organizations or upgrade their legacy choices.");
    }
  }
  // The store checks the revision again under the shared lock. Local settings
  // remain untouched, so a concurrent local OFF continues to restrict capture.
  return store.setRepositoryOverride(repository, enabled, { expectedRevision, acknowledged, onCommitted });
}
module.exports = { applyRepositoryConsent, parseConsentChoiceArgs, CONSENT_SET_USAGE };

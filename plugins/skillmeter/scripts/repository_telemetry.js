#!/usr/bin/env node
/**
 * Organization and repository choices for sign-in onboarding, with the same
 * commands as the Claude Code plugin. Output is JSON on stdout; errors go to
 * stderr as `SkillMeter: CODE: message` with exit code 1.
 * Usage: node scripts/repository_telemetry.js list
 *        node scripts/repository_telemetry.js onboard REVISION ORG enabled|disabled [KEY...] [--acknowledge-machine-scope]
 *        node scripts/repository_telemetry.js org REVISION ORG enabled|disabled [--acknowledge-machine-scope]
 * REVISION is the `revision` from the latest list (`absent` before the first choice).
 */

const USAGE = "usage: repository_telemetry.js list | onboard REVISION ORG enabled|disabled [KEY...] [--acknowledge-machine-scope] | org REVISION ORG enabled|disabled [--acknowledge-machine-scope]";
const error = (code, message) => Object.assign(new Error(message), { code });

const { loadInventory } = require("./lib/repository-inventory");

function parseWrite(args) {
  const acknowledged = args.includes("--acknowledge-machine-scope");
  const [revisionArg, org, setting, ...keys] = args.filter(arg => arg !== "--acknowledge-machine-scope");
  if (revisionArg !== "absent" && !/^(0|[1-9][0-9]*)$/.test(revisionArg || "")) throw error("INVALID_ARGUMENTS", USAGE);
  if (!org || !["enabled", "disabled"].includes(setting)) throw error("INVALID_ARGUMENTS", USAGE);
  return {
    expectedRevision: revisionArg === "absent" ? null : Number(revisionArg),
    organization: org,
    enabled: setting === "enabled",
    keys,
    acknowledged,
  };
}

function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!["list", "onboard", "org"].includes(action)) throw error("INVALID_ARGUMENTS", USAGE);
  if (action === "list") {
    if (args.length) throw error("INVALID_ARGUMENTS", USAGE);
    process.stdout.write(JSON.stringify(loadInventory().inventory) + "\n");
    return;
  }

  const options = parseWrite(args);
  if (action === "org" && options.keys.length) throw error("INVALID_ARGUMENTS", USAGE);
  const { store, inventory, logger } = loadInventory();
  if (options.expectedRevision !== (inventory.revision === "absent" ? null : inventory.revision)) {
    process.stdout.write(JSON.stringify({ stale: true, revision: inventory.revision }) + "\n");
    return;
  }

  let cleaned = false;
  const onCommitted = () => {
    // As in consent-set: observe the saved choice before the writer lock is
    // released. Cleanup failures cannot roll back consent.
    try { cleaned = logger.reconcileConsentRevocations(); logger.observeKnownTranscriptConsent(); }
    catch { cleaned = false; }
  };
  const apply = require("./lib/consent-apply");
  let policy;
  try {
    policy = action === "onboard"
      ? apply.applyOnboardingSelection({
          store, inventory, organization: options.organization, repositories: options.keys,
          repositoriesEnabled: options.enabled, expectedRevision: options.expectedRevision,
          acknowledged: options.acknowledged, onCommitted,
        })
      : apply.applyOrganizationConsent({
          store, allowedOrgs: inventory.orgs.map(entry => entry.org), organization: options.organization,
          enabled: options.enabled, expectedRevision: options.expectedRevision,
          acknowledged: options.acknowledged, onCommitted,
        });
  } catch (err) {
    if (err.code !== "STALE_POLICY") throw err;
    process.stdout.write(JSON.stringify({ stale: true, revision: loadInventory().inventory.revision }) + "\n");
    return;
  }

  const org = options.organization.trim().toLowerCase();
  const after = loadInventory().inventory;
  const keys = new Set(options.keys);
  process.stdout.write(JSON.stringify({
    revision: policy.revision,
    organization: org,
    consent: after.orgs.find(entry => entry.org === org)?.consent ?? null,
    globalPaused: after.globalPaused,
    results: after.repositories
      .filter(repo => keys.has(repo.key))
      .map(({ key, displayName, effective }) => ({ key, displayName, effective })),
    // OFF removes queued payloads; report when that cleanup was deferred.
    cleanupDeferred: !options.enabled && !cleaned,
    durabilityUnconfirmed: policy.durability === "unconfirmed",
  }) + "\n");
}

try {
  main();
} catch (err) {
  process.stderr.write(`SkillMeter: ${err.code || "REPOSITORY_TELEMETRY_FAILED"}: ${err.message}\n`);
  process.exitCode = 1;
}

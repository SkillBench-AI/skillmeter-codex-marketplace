#!/usr/bin/env node
/**
 * Organization and repository choices for sign-in onboarding and the
 * telemetry list picker, with the same commands as the Claude Code plugin.
 * Output is JSON on stdout; errors go to stderr as `SkillMeter: CODE: message`
 * with exit code 1.
 * Usage: node scripts/repository_telemetry.js list
 *        node scripts/repository_telemetry.js toggle REVISION KEY... [--acknowledge-machine-scope]
 *        node scripts/repository_telemetry.js onboard REVISION ORG enabled|disabled [KEY...] [--acknowledge-machine-scope]
 *        node scripts/repository_telemetry.js org REVISION ORG enabled|disabled [--acknowledge-machine-scope]
 * REVISION is the `revision` from the latest list (`absent` before the first choice).
 */

const USAGE = "usage: repository_telemetry.js list | toggle REVISION KEY... [--acknowledge-machine-scope] | onboard REVISION ORG enabled|disabled [KEY...] [--acknowledge-machine-scope] | org REVISION ORG enabled|disabled [--acknowledge-machine-scope]";
const error = (code, message) => Object.assign(new Error(message), { code });

const { loadInventory } = require("./lib/repository-inventory");

function parseWrite(action, args) {
  const acknowledged = args.includes("--acknowledge-machine-scope");
  const rest = args.filter(arg => arg !== "--acknowledge-machine-scope");
  const revisionArg = rest.shift();
  if (revisionArg !== "absent" && !/^(0|[1-9][0-9]*)$/.test(revisionArg || "")) throw error("INVALID_ARGUMENTS", USAGE);
  const expectedRevision = revisionArg === "absent" ? null : Number(revisionArg);
  if (action === "toggle") {
    if (!rest.length) throw error("INVALID_ARGUMENTS", USAGE);
    return { expectedRevision, keys: rest, acknowledged };
  }
  const [org, setting, ...keys] = rest;
  if (!org || !["enabled", "disabled"].includes(setting)) throw error("INVALID_ARGUMENTS", USAGE);
  if (action === "org" && keys.length) throw error("INVALID_ARGUMENTS", USAGE);
  return { expectedRevision, organization: org, enabled: setting === "enabled", keys, acknowledged };
}

function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!["list", "toggle", "onboard", "org"].includes(action)) throw error("INVALID_ARGUMENTS", USAGE);
  if (action === "list") {
    if (args.length) throw error("INVALID_ARGUMENTS", USAGE);
    process.stdout.write(JSON.stringify(loadInventory().inventory) + "\n");
    return;
  }

  const options = parseWrite(action, args);
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
  const common = { store, inventory, expectedRevision: options.expectedRevision, acknowledged: options.acknowledged, onCommitted };
  let policy;
  try {
    if (action === "toggle") {
      policy = apply.applyRepositoryToggles({ ...common, repositories: options.keys });
    } else if (action === "onboard") {
      policy = apply.applyOnboardingSelection({ ...common, organization: options.organization,
        repositories: options.keys, repositoriesEnabled: options.enabled });
    } else {
      policy = apply.applyOrganizationConsent({ ...common, allowedOrgs: inventory.orgs.map(entry => entry.org),
        organization: options.organization, enabled: options.enabled });
    }
  } catch (err) {
    if (err.code !== "STALE_POLICY") throw err;
    process.stdout.write(JSON.stringify({ stale: true, revision: loadInventory().inventory.revision }) + "\n");
    return;
  }

  const after = loadInventory().inventory;
  const keys = new Set(options.keys);
  const before = new Map(inventory.repositories.map(repo => [repo.key, repo]));
  const results = after.repositories.filter(repo => keys.has(repo.key)).map(({ key, displayName, effective }) => {
    if (action !== "toggle") return { key, displayName, effective };
    const { action: change, blockedBy } = before.get(key);
    return { key, displayName, changed: Boolean(policy && change), effective, ...(change ? {} : { reason: blockedBy }) };
  });
  // OFF removes queued payloads; report when that cleanup was deferred.
  const turnedOff = action === "toggle"
    ? options.keys.some(key => before.get(key)?.action === "disable")
    : !options.enabled;
  const summary = { revision: policy ? policy.revision : inventory.revision };
  if (action !== "toggle") {
    const org = options.organization.trim().toLowerCase();
    Object.assign(summary, { organization: org, consent: after.orgs.find(entry => entry.org === org)?.consent ?? null });
  }
  process.stdout.write(JSON.stringify({
    ...summary,
    globalPaused: after.globalPaused,
    results,
    cleanupDeferred: Boolean(policy) && turnedOff && !cleaned,
    durabilityUnconfirmed: policy?.durability === "unconfirmed",
  }) + "\n");
}

try {
  main();
} catch (err) {
  process.stderr.write(`SkillMeter: ${err.code || "REPOSITORY_TELEMETRY_FAILED"}: ${err.message}\n`);
  process.exitCode = 1;
}

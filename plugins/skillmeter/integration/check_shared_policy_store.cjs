"use strict";

// Run against a pinned Claude checkout. All policy, home and plugin data are
// temporary; no installed plugin, credentials or network services are used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createSharedPolicyStore } = require("../scripts/lib/shared-policy-store");

const version2 = process.argv.includes("--v2");
const claudeRoot = process.argv[2] && path.resolve(process.argv[2]);
if (!claudeRoot) throw new Error("Usage: node check_shared_policy_store.cjs /path/to/pinned/claude-checkout");
const bootstrap = path.join(claudeRoot, "skillmeter/testing/bootstrap.js");
const claudeModule = path.join(claudeRoot, "skillmeter/scripts/lib/telemetry-store.js");
assert.ok(fs.existsSync(bootstrap) && fs.existsSync(claudeModule), "Claude checkout must provide the canonical store and test bootstrap");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "skillmeter-store-compat-"));
const file = path.join(root, "state/telemetry-policy.json");
const store = createSharedPolicyStore({ file, observedFile: path.join(root, "codex-data/policy-observed") });
const repo = "github.com/acme/widgets";
const other = "github.com/acme/other";
const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, SKILLMETER_STATE_DIR: path.dirname(file), SKILLMETER_DISABLE_KEYCHAIN: "1" };

function claude(source) {
  const result = spawnSync(process.execPath, ["-e", `
    require(${JSON.stringify(bootstrap)});
    const assert = require('node:assert/strict');
    const store = require(${JSON.stringify(claudeModule)});
    ${source}
  `], {
    cwd: root, encoding: "utf8", timeout: 10_000,
    env,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
}

function concurrentWriter(setup, action) {
  const child = spawn(process.execPath, ["-e", `
    ${setup}
    process.send('ready');
    process.once('message', () => {
      try { ${action}; process.send('ok'); }
      catch (error) { process.send(error.code); }
      process.disconnect();
    });
  `], { cwd: root, env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let diagnostic = "";
  child.stderr.on("data", data => { diagnostic += data; });
  const timer = setTimeout(() => child.kill(), 10_000);
  const ready = new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`Writer exited before ready: ${diagnostic}`)));
  });
  const result = new Promise((resolve, reject) => {
    let outcome;
    child.on("message", message => { if (message !== "ready") outcome = message; });
    child.once("error", reject);
    child.once("exit", code => {
      clearTimeout(timer);
      if (code === 0) resolve(outcome);
      else reject(new Error(`Writer failed: ${diagnostic}`));
    });
  });
  return { child, ready, result };
}

async function run() {
try {
  if (version2) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const legacy = { schema_version: 1, revision: 1, global: { enabled: true },
      organizations: { acme: { enabled: true, consent_version: 1 } },
      repositories: { [repo]: { enabled: true }, [other]: { enabled: false } } };
    fs.writeFileSync(file, JSON.stringify(legacy));
    claude(`assert.equal(store.acknowledgementRequired(), true);
      assert.deepEqual(store.acknowledgeConsentStatement(1), { revision: 2, acknowledged: 2 });`);
    const confirmed = store.readPolicy();
    assert.equal(confirmed.organizations.acme.consent_version, 2);
    assert.equal(confirmed.repositories[repo].consent_version, 2);
    assert.equal(confirmed.repositories[other].enabled, false);
    assert.equal(confirmed.repositories[other].consent_version, undefined);
    claude(`assert.equal(store.acknowledgementRequired(), false);`);
  }
  // Verify the pinned writer's version explicitly; never silently promote a
  // legacy implementation into the version-2 acceptance path.
  claude(`store.setOrganizationConsent('acme', true); store.setRepositoryOverride('${repo}', true);`);
  const legacy = store.readPolicy();
  assert.equal(legacy.organizations.acme.consent_version, version2 ? 2 : 1);
  assert.equal(legacy.repositories[repo].consent_version, version2 ? 2 : undefined);
  const acknowledged = store.setRepositoryOverride(repo, true, { expectedRevision: legacy.revision, acknowledged: true });

  // An unrelated old-client write must preserve the new nested version field.
  claude(`store.setRepositoryOverride('${other}', false, ${acknowledged.revision});`);
  assert.deepEqual(store.readPolicy().repositories[repo], acknowledged.repositories[repo]);
  claude(`assert.equal(store.getRepositoryOverride('${repo}'), true);`);

  // Actual Claude writes OFF between Codex's preview and confirmation.
  const preview = store.readPolicy();
  claude(`store.setRepositoryOverride('${repo}', false, ${preview.revision});`);
  assert.throws(() => store.setRepositoryOverride(repo, true, { expectedRevision: preview.revision, acknowledged: true }), { code: "STALE_POLICY" });
  assert.equal(store.readPolicy().repositories[repo].enabled, false);
  assert.equal(store.readPolicy().repositories[repo].consent_version, version2 ? 2 : undefined);

  // Both clients use the same lock path. Test the real Claude lock timeout.
  fs.writeFileSync(`${file}.lock`, "synthetic-active-writer");
  claude(`assert.throws(() => store.setGlobalEnabled(false), /busy/);`);
  assert.throws(() => store.setGlobalEnabled(false, { expectedRevision: store.readPolicy().revision }), { code: "POLICY_BUSY" });
  fs.unlinkSync(`${file}.lock`);

  const paused = store.setGlobalEnabled(false, { expectedRevision: store.readPolicy().revision });
  claude(`assert.equal(store.getGlobalDisabled(), true); store.setRepositoryOverride('${other}', true, ${paused.revision});`);
  assert.equal(store.readPolicy().global.enabled, false);

  const revision = store.readPolicy().revision;
  const writers = [
    concurrentWriter(`require(${JSON.stringify(bootstrap)}); const store = require(${JSON.stringify(claudeModule)});`, `store.setRepositoryOverride('${repo}', false, ${revision})`),
    concurrentWriter(`const store = require(${JSON.stringify(path.resolve(__dirname, "../scripts/lib/shared-policy-store"))}).createSharedPolicyStore(${JSON.stringify({ file, observedFile: path.join(root, "codex-data/policy-observed") })});`, `store.setRepositoryOverride('${other}', false, { expectedRevision: ${revision} })`),
  ];
  try {
    const outcomes = Promise.all(writers.map(writer => writer.result));
    // Awaited below. If a writer exits before "ready", that await never runs,
    // so the rejection here must not surface as an unhandled one.
    outcomes.catch(() => {});
    await Promise.all(writers.map(writer => writer.ready));
    writers.forEach(writer => writer.child.send("write"));
    assert.deepEqual((await outcomes).sort(), ["STALE_POLICY", "ok"]);
    assert.equal(store.readPolicy().revision, revision + 1);
  } finally {
    writers.forEach(writer => { if (writer.child.exitCode === null) writer.child.kill(); });
  }
  process.stdout.write("PASS: selected writer version, acknowledgement (v2 mode), version preservation, stale OFF protection, shared lock, alternating and concurrent Claude/Codex writes\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
}

run().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });

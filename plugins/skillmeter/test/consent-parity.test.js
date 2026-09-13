"use strict";
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-consent-parity-"));
os.homedir = () => root;
process.env.SKILLMETER_STATE_DIR = path.join(root, "state");
process.env.PLUGIN_DATA = path.join(root, "data");
process.env.GIT_CONFIG_GLOBAL = path.join(root, "empty-gitconfig");
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
const policy = require("../scripts/lib/telemetry-store");
const { CRED_FILE } = require("../scripts/lib/config");
const jwt = org => "e30." + Buffer.from(JSON.stringify({
  exp: 4102444800, aud: "https://synthetic.meter.skillbench.ai", github_id: 123, org: { login: org },
})).toString("base64url") + ".fixture";
const repo = name => {
  const dir = path.join(root, name);
  execFileSync("git", ["init", "--quiet", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/synthetic/shared.git"]);
  return dir;
};
const a = repo("a"), b = repo("b");
beforeEach(() => {
  fs.rmSync(process.env.PLUGIN_DATA, { recursive: true, force: true });
  fs.rmSync(process.env.SKILLMETER_STATE_DIR, { recursive: true, force: true });
  fs.mkdirSync(process.env.SKILLMETER_STATE_DIR);
  fs.writeFileSync(CRED_FILE, JSON.stringify({ device_id: "SYNTHETIC", hash_salt: "fixture", license_jwt: jwt("synthetic"), allowed_github_orgs: ["synthetic", "other"] }));
  for (const dir of [a, b]) fs.rmSync(path.join(dir, ".codex"), { recursive: true, force: true });
});
after(() => fs.rmSync(root, { recursive: true, force: true }));
test("a licensed org with no repository decision never auto-enables", () => {
  const logger = require("../scripts/logger");
  assert.equal(logger.captureGate(a).capture, false);
  policy.setOrganizationConsent("synthetic", true);
  assert.deepEqual(logger.captureGate(a), { capture: false, mode: "repository_consent_required" });
});
test("explicit canonical consent is shared by two clones", () => {
  const logger = require("../scripts/logger");
  policy.authorizeOrganizationRepositories("synthetic", ["github.com/synthetic/shared"], true);
  assert.equal(logger.captureGate(a).capture, true);
  assert.equal(logger.captureGate(b).capture, true);
  policy.setRepositoryOverride("synthetic/shared", false);
  assert.equal(logger.captureGate(a).capture, false);
  assert.equal(logger.captureGate(b).capture, false);
});
test("legacy membership list cannot widen the licensed organization", () => {
  const logger = require("../scripts/logger");
  fs.writeFileSync(CRED_FILE, JSON.stringify({ device_id: "SYNTHETIC", hash_salt: "fixture", license_jwt: jwt("other"), allowed_github_orgs: ["synthetic"] }));
  assert.equal(logger.getRepoScopeDecision(a).allowed, false);
});
test("legacy explicit OFF survives canonical opt-in until explicitly changed", () => {
  const logger = require("../scripts/logger");
  policy.authorizeOrganizationRepositories("synthetic", ["synthetic/shared"], true);
  fs.mkdirSync(path.join(a, ".codex"));
  fs.writeFileSync(path.join(a, ".codex/settings.local.json"), '{"skillmeter":{"telemetry":false}}');
  assert.equal(logger.captureGate(a).capture, false);
  logger.saveTelemetryOptIn(a, true);
  assert.equal(logger.captureGate(a).capture, true);
});
test("queued events retain repository and principal identity across retries", async () => {
  const logger = require("../scripts/logger");
  policy.authorizeOrganizationRepositories("synthetic", ["synthetic/shared"], true);
  const scope = logger.transcriptScope(a);
  logger.logInfo("UserPromptSubmit", "synthetic-session", { prompt: "synthetic" }, "SYNTHETIC", scope);
  const file = logger.sealEventLog(a);
  assert.ok(file);
  assert.ok(file.startsWith(logger.REPOSITORIES_LOG_DIR + path.sep));
  const realFetch = global.fetch;
  let requests = 0;
  global.fetch = async () => { requests++; return { ok: true }; };
  try {
    const creds = JSON.parse(fs.readFileSync(CRED_FILE));
    creds.license_jwt = "e30." + Buffer.from(JSON.stringify({ exp: 4102444800, aud: "https://synthetic.meter.skillbench.ai", github_id: 456, org: { login: "synthetic" } })).toString("base64url") + ".fixture";
    fs.writeFileSync(CRED_FILE, JSON.stringify(creds));
    assert.equal(await logger.transferEventLog(file), "skip");
    assert.equal(requests, 0);
    assert.equal(fs.existsSync(file), true);
    creds.license_jwt = jwt("synthetic");
    fs.writeFileSync(CRED_FILE, JSON.stringify(creds));
    assert.equal(await logger.transferEventLog(file), "sent");
    assert.equal(requests, 1);
  } finally { global.fetch = realFetch; }
});
test("repository OFF purges its event payload, and legacy unscoped events stay unsent", async () => {
  const logger = require("../scripts/logger");
  policy.authorizeOrganizationRepositories("synthetic", ["synthetic/shared"], true);
  logger.logInfo("UserPromptSubmit", "synthetic-session", {}, "SYNTHETIC", logger.transcriptScope(a));
  const file = logger.sealEventLog(a);
  policy.setRepositoryOverride("synthetic/shared", false);
  assert.deepEqual(logger.listSealedEventLogs(), []);
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(logger.LOG_FILE + ".123", "legacy");
  assert.equal(await logger.transferEventLog(logger.LOG_FILE + ".123"), "skip");
  assert.equal(fs.readFileSync(logger.LOG_FILE + ".123", "utf8"), "legacy");
});
test("global pause retains authorized event payloads; repeated enable retains consent identity", async () => {
  const logger = require("../scripts/logger");
  logger.saveTelemetryOptIn(a, true);
  const before = policy.readPolicy();
  logger.logInfo("UserPromptSubmit", "synthetic-session", {}, "SYNTHETIC", logger.transcriptScope(a));
  const file = logger.sealEventLog(a);
  logger.saveTelemetryOptIn(b, true);
  assert.deepEqual(policy.readPolicy(), before);
  policy.setGlobalEnabled(false);
  assert.equal(await logger.transferEventLog(file), "skip");
  assert.equal(fs.existsSync(file), true);
  policy.setGlobalEnabled(true);
  assert.deepEqual(logger.listSealedEventLogs(), [file]);
});
test("unsupported shared policy is blocked without rewriting it", () => {
  const raw = JSON.stringify({ schema_version: 999, revision: 42, global: {enabled:true}, organizations: {synthetic:{enabled:true}}, repositories:{"github.com/synthetic/shared":{enabled:true}} });
  fs.writeFileSync(policy.TELEMETRY_POLICY_FILE, raw);
  assert.throws(() => require("../scripts/logger").captureGate(a), {code:"UNSUPPORTED_TELEMETRY_POLICY"});
  assert.throws(() => policy.setGlobalEnabled(false), {code:"UNSUPPORTED_TELEMETRY_POLICY"});
  assert.equal(fs.readFileSync(policy.TELEMETRY_POLICY_FILE, "utf8"), raw);
});
test("concurrent drains send a sealed event batch once", async () => {
  const logger = require("../scripts/logger");
  logger.saveTelemetryOptIn(a, true);
  logger.logInfo("UserPromptSubmit", "synthetic-session", {}, "SYNTHETIC", logger.transcriptScope(a));
  const file = logger.sealEventLog(a);
  const realFetch = global.fetch;
  let complete, requests = 0;
  global.fetch = () => { requests++; return new Promise(resolve => { complete = () => resolve({ok:true}); }); };
  try {
    const first = logger.processSealedBatch(file);
    assert.equal(await logger.processSealedBatch(file), "skip");
    complete();
    assert.equal(await first, "sent");
    assert.equal(requests, 1);
  } finally { global.fetch = realFetch; }
});
test("quarantine stays repository-bound and OFF removes quarantined payloads", () => {
  const logger = require("../scripts/logger");
  logger.saveTelemetryOptIn(a, true);
  logger.logInfo("UserPromptSubmit", "synthetic-session", {}, "SYNTHETIC", logger.transcriptScope(a));
  const file = logger.sealEventLog(a);
  logger.quarantineFile(file, "synthetic rejection");
  const poison = path.join(path.dirname(file), "poison", path.basename(file));
  assert.equal(fs.existsSync(poison), true);
  logger.saveTelemetryOptIn(b, false);
  assert.equal(fs.existsSync(poison), false);
});

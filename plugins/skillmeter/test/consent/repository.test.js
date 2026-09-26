"use strict";
// Repository consent: the in-process gate, and the boundary as the real hook
// and control scripts enforce it from a checkout.
const { isolateHome, sandbox, tempDir, STRICT_PRELOAD } = require("../../test-support/plugin.cjs");
isolateHome();

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const logger = require("../../scripts/logger");

test("resolveTelemetryGate: explicit choice and ownership scope combine fail-closed", () => {
  for (const [choice, allowed, expected] of [
    [false, true, { capture: false, mode: "opted_out" }],
    [false, false, { capture: false, mode: "opted_out" }],
    [true, true, { capture: true, mode: "opted_in" }],
    [true, false, { capture: false, mode: "out_of_scope" }],
    [null, true, { capture: false, mode: "not_enabled" }],
    [null, false, { capture: false, mode: "out_of_scope" }],
  ]) assert.deepEqual(logger.resolveTelemetryGate(choice, allowed), expected, `${choice}/${allowed}`);
});

test("defaultGateMessaging is silent when capturing and names the reason otherwise", () => {
  const original = console.error;
  const lines = [];
  console.error = msg => lines.push(msg);
  try {
    logger.defaultGateMessaging("PreToolUse", { capture: true, mode: "opted_in" });
    assert.equal(lines.length, 0);
    logger.defaultGateMessaging("PreToolUse", { capture: false, mode: "out_of_scope" });
    logger.defaultGateMessaging("PreToolUse", { capture: false, mode: "opted_out" });
    logger.defaultGateMessaging("PreToolUse", { capture: false, mode: "not_enabled" });
  } finally {
    console.error = original;
  }
  assert.match(lines[0], /out of scope/);
  assert.match(lines[1], /disabled for this project/);
  assert.match(lines[2], /telemetry not enabled/);
});

test("writeTelemetryConsentFallback prints the in-context commands without saving a decision", () => {
  const cwd = tempDir("sk-consent-project");
  const chunks = [];
  logger.writeTelemetryConsentFallback(cwd, { write: chunk => chunks.push(chunk) });
  const output = chunks.join("");
  assert.equal(logger.getTelemetryOptIn(cwd), null);
  assert.match(output, /Telemetry is not configured/);
  for (const action of ["enable", "disable", "status"]) assert.match(output, new RegExp(`telemetry\\.js" ${action}`));
});

test("saveTelemetryOptIn round-trips through getTelemetryOptIn", () => {
  const cwd = tempDir("sk-consent-project");
  assert.equal(logger.getTelemetryOptIn(cwd), null);
  logger.saveTelemetryOptIn(cwd, true);
  assert.equal(logger.getTelemetryOptIn(cwd), true);
  logger.saveTelemetryOptIn(cwd, false);
  assert.equal(logger.getTelemetryOptIn(cwd), false);
});

const EVENT = { session_id: "synthetic-session", tool_name: "synthetic", tool_input: { message: "synthetic event" } };
function checkout(t) {
  const box = sandbox(t, { prefix: "codex-consent" });
  const control = (action, cwd = box.repo) => {
    const result = box.script("telemetry.js", { args: [action], cwd, input: { ...EVENT, cwd } });
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  const hook = (cwd = box.repo, input = {}) => {
    const result = box.script("pre_tool_use.js", { cwd, input: { ...EVENT, cwd, ...input } });
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  const subdirSettings = (value, name = "src") => {
    const subdir = path.join(box.repo, name);
    fs.mkdirSync(path.join(subdir, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(subdir, ".codex", "settings.local.json"), typeof value === "string" ? value : JSON.stringify(value));
    return subdir;
  };
  return { ...box, control, hook, subdirSettings };
}

test("an unselected owned repository creates no events or capture hints", t => {
  const f = checkout(t);
  const source = path.join(f.root, "synthetic.jsonl");
  fs.writeFileSync(source, "{}\n");
  const result = f.hook(f.repo, { transcript_path: source });
  assert.deepEqual(f.events(), []);
  assert.equal(fs.existsSync(path.join(f.data, "logs/transcripts/captures-v1")), false);
  assert.equal(f.spawned(), false);
  assert.match(result.stderr, /telemetry not enabled/);
});

test("an explicit enable persists across hook processes and a disable stops new capture", t => {
  const f = checkout(t);
  f.control("enable");
  f.hook(); f.hook();
  assert.equal(f.events().length, 2);
  f.control("disable");
  f.hook();
  assert.equal(f.events().length, 0);
});

test("the repository-root choice applies to hooks and controls in subdirectories", t => {
  const f = checkout(t);
  const subdir = path.join(f.repo, "src");
  fs.mkdirSync(subdir);
  f.control("enable", subdir);
  assert.equal(JSON.parse(fs.readFileSync(f.settings)).skillmeter.telemetry, true);
  assert.equal(fs.existsSync(path.join(subdir, ".codex/settings.local.json")), false);
  f.hook(); f.hook(subdir);
  assert.equal(f.events().length, 2);
  f.control("disable", subdir);
  f.hook(); f.hook(subdir);
  assert.equal(f.events().length, 0);
});

test("parent consent does not enable an unselected nested repository", t => {
  const f = checkout(t);
  f.control("enable");
  const nested = path.join(f.repo, "nested");
  fs.mkdirSync(path.join(nested, ".git"), { recursive: true });
  fs.writeFileSync(path.join(nested, ".git/config"), '[remote "origin"]\nurl = https://github.com/acme/another.git\n');
  f.hook(nested);
  assert.deepEqual(f.events(), []);
});

test("the global pause and scope exclusion override an explicit repository enable", t => {
  const f = checkout(t);
  f.control("enable");
  f.saveCredentials({ telemetry_disabled: true }); f.hook();
  assert.deepEqual(f.events(), []);
  f.saveCredentials({ allowed_github_orgs: ["another"] }); f.hook();
  assert.deepEqual(f.events(), []);
  f.saveCredentials({}); f.hook();
  assert.equal(f.events().length, 1);
});

for (const value of ["{", "[]", '{"skillmeter":{"telemetry":"true"}}']) {
  test(`malformed root consent never authorizes capture: ${value}`, t => {
    const f = checkout(t);
    fs.mkdirSync(path.dirname(f.settings));
    fs.writeFileSync(f.settings, value);
    f.hook();
    assert.deepEqual(f.events(), []);
  });
}

test("the CLI refuses to overwrite malformed settings while enabling", t => {
  const f = checkout(t);
  fs.mkdirSync(path.dirname(f.settings));
  fs.writeFileSync(f.settings, "{");
  const result = f.script("telemetry.js", { args: ["enable"] });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(f.settings, "utf8"), "{");
});

test("repository controls preserve other settings and the shared credentials", t => {
  const f = checkout(t);
  fs.mkdirSync(path.dirname(f.settings));
  fs.writeFileSync(f.settings, JSON.stringify({ unrelated: "keep", skillmeter: { repoScopeOrgs: ["acme"] } }));
  const before = fs.readFileSync(f.credentialFile);
  f.control("enable"); f.control("disable");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)), { unrelated: "keep", skillmeter: { repoScopeOrgs: ["acme"], telemetry: false } });
  assert.deepEqual(fs.readFileSync(f.credentialFile), before);
});

test("SessionStart asks for a choice in an unselected repository without starting monitors", t => {
  const f = checkout(t);
  const result = f.script("session_start.js", { input: { ...EVENT, cwd: f.repo } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Telemetry is not configured/);
  assert.doesNotMatch(result.stderr, /auto-enabled|\(activated\)/);
  assert.equal(f.spawned(), false);
  assert.deepEqual(f.events(), []);
});

test("SessionStart does not start monitors for an opted-in repository that is out of scope", t => {
  const f = checkout(t);
  f.control("enable");
  f.saveCredentials({ allowed_github_orgs: ["another"] });
  const result = f.script("session_start.js", { input: { ...EVENT, cwd: f.repo } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /repository out of scope/);
  assert.equal(f.spawned(), false);
  assert.deepEqual(f.events(), []);
});

test("a subdirectory opt-in alone cannot authorize the repository", t => {
  const f = checkout(t);
  const subdir = f.subdirSettings({ skillmeter: { telemetry: true } });
  f.hook(subdir); f.hook();
  assert.deepEqual(f.events(), []);
});

for (const value of [{ skillmeter: { telemetry: false } }, 42, { skillmeter: [] }, { skillmeter: { telemetry: "false" } }]) {
  test(`a restrictive or malformed descendant setting blocks root consent: ${JSON.stringify(value)}`, t => {
    const f = checkout(t);
    f.control("enable");
    f.hook(f.subdirSettings(value));
    assert.deepEqual(f.events(), []);
    assert.equal(f.spawned(), false);
  });
}

for (const value of [{ skillmeter: {} }, { skillmeter: { telemetry: true } }]) {
  test(`a permissive descendant setting retains root consent: ${JSON.stringify(value)}`, t => {
    const f = checkout(t);
    f.control("enable");
    f.hook(f.subdirSettings(value));
    assert.equal(f.events().length, 1);
  });
}

test("routing lock contention keeps the Stop hook's JSON and reports a retryable control failure", t => {
  const f = checkout(t);
  f.control("enable");
  const routing = path.join(f.data, "logs/repository-routing");
  const id = require("node:crypto").createHmac("sha256", f.credentials.hash_salt).update(fs.realpathSync(f.repo)).digest("hex").slice(0, 12);
  const release = require("../../scripts/lib/transcript-delta").acquireLock(path.join(routing, `${id}.json.lock`));
  assert.ok(release);
  try {
    const hook = f.script("stop.js", { input: { ...EVENT, cwd: f.repo } });
    assert.equal(hook.status, 0, hook.stderr);
    assert.deepEqual(JSON.parse(hook.stdout), {});
    assert.match(hook.stderr, /repository routing unavailable/);
    assert.deepEqual(f.events(), []);
    const control = f.script("telemetry.js", { args: ["disable"] });
    assert.equal(control.status, 1);
    assert.match(control.stderr, /busy.*retry/i);
    assert.equal(JSON.parse(fs.readFileSync(f.settings)).skillmeter.telemetry, true);
  } finally { release(); }
  f.control("disable");
  assert.equal(JSON.parse(fs.readFileSync(f.settings)).skillmeter.telemetry, false);
});

"use strict";

/**
 * Unit tests for in-context telemetry consent (SBEE-157).
 *
 * Consent is collected entirely in-context: an explicit per-project opt-in plus
 * owned-org auto-enable. There is no OS-native dialog (removed — Codex hooks run
 * without a TTY, and system pop-ups read as spyware / can't render headless).
 * This mirrors the Claude Code plugin and the VS Code extension.
 *
 * Run with: node --test plugins/skillmeter/test/telemetry-consent.test.js
 */

const os = require("os");
const fs = require("fs");
const path = require("path");

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "sk-consent-home-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { test } = require("node:test");
const assert = require("node:assert/strict");

const logger = require("../scripts/logger");

function makeProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sk-consent-project-"));
}

function stderrSink() {
  const chunks = [];
  return {
    stream: { write: (chunk) => chunks.push(chunk) },
    output: () => chunks.join(""),
  };
}

test("the plugin exposes no OS-dialog consent surface", () => {
  // Regression guard: the native-dialog path (osascript / MessageBox /
  // zenity/kdialog) was intentionally removed. If any of these come back,
  // consent has diverged from the in-context model again.
  assert.equal(typeof logger.resolveTelemetryConsent, "undefined");
  assert.equal(typeof logger.promptTelemetryOptIn, "undefined");
});

test("resolveTelemetryGate requires license, organization and repository consent", () => {
  const enabled = { globalDisabled: false, hasValidLicense: true, repoOrgOwned: true, orgConsent: true, projectOptIn: true };
  assert.equal(logger.resolveTelemetryGate(enabled).capture, true);
  for (const change of [{ globalDisabled: true }, { hasValidLicense: false }, { repoOrgOwned: false }, { orgConsent: null }, { orgConsent: false }, { projectOptIn: null }, { projectOptIn: false }]) {
    assert.equal(logger.resolveTelemetryGate({ ...enabled, ...change }).capture, false);
  }
});

test("writeTelemetryConsentFallback prints in-context commands without saving a decision", () => {
  const cwd = makeProject();
  const sink = stderrSink();

  logger.writeTelemetryConsentFallback(cwd, sink.stream);

  // No decision is persisted — the project stays "not configured".
  assert.equal(logger.getTelemetryOptIn(cwd), null);
  assert.match(sink.output(), /Telemetry is not configured/);
  assert.match(sink.output(), /telemetry\.js" enable/);
  assert.match(sink.output(), /telemetry\.js" disable/);
  assert.match(sink.output(), /telemetry\.js" status/);
});

test("saveTelemetryOptIn refuses to authorize a directory outside licensed scope", () => {
  const cwd = makeProject();
  assert.throws(() => logger.saveTelemetryOptIn(cwd, true), /eligible repository/);
  assert.equal(logger.getTelemetryOptIn(cwd), null);
});

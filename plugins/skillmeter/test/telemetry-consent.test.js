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

test("resolveTelemetryGate: explicit opt-out is always respected", () => {
  // opted_out beats owned-org auto-enable.
  assert.deepEqual(logger.resolveTelemetryGate(false, true), {
    capture: false,
    mode: "opted_out",
  });
  assert.deepEqual(logger.resolveTelemetryGate(false, false), {
    capture: false,
    mode: "opted_out",
  });
});

test("resolveTelemetryGate: explicit opt-in captures regardless of ownership", () => {
  // Downstream repo-scope still drops out-of-scope repos; the gate only decides
  // per-project intent.
  assert.deepEqual(logger.resolveTelemetryGate(true, true), {
    capture: true,
    mode: "opted_in",
  });
  assert.deepEqual(logger.resolveTelemetryGate(true, false), {
    capture: true,
    mode: "opted_in",
  });
});

test("resolveTelemetryGate: unset auto-enables only for an owned-org repo", () => {
  assert.deepEqual(logger.resolveTelemetryGate(null, true), {
    capture: true,
    mode: "auto_org",
  });
  assert.deepEqual(logger.resolveTelemetryGate(null, false), {
    capture: false,
    mode: "not_enabled",
  });
});

test("defaultGateMessaging: auto_org announces auto-enable + how to opt out", () => {
  const original = console.error;
  const lines = [];
  console.error = (msg) => lines.push(msg);
  try {
    logger.defaultGateMessaging("PreToolUse", { capture: true, mode: "auto_org" });
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /auto-enabled/);
  assert.match(lines[0], /disable/);
});

test("defaultGateMessaging: opted_in is silent, skips report a reason", () => {
  const original = console.error;
  const lines = [];
  console.error = (msg) => lines.push(msg);
  try {
    logger.defaultGateMessaging("PreToolUse", { capture: true, mode: "opted_in" });
    assert.equal(lines.length, 0);

    logger.defaultGateMessaging("PreToolUse", { capture: false, mode: "opted_out" });
    logger.defaultGateMessaging("PreToolUse", { capture: false, mode: "not_enabled" });
  } finally {
    console.error = original;
  }
  assert.match(lines[0], /disabled for this project/);
  assert.match(lines[1], /telemetry not enabled/);
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

test("saveTelemetryOptIn round-trips through getTelemetryOptIn", () => {
  const cwd = makeProject();
  assert.equal(logger.getTelemetryOptIn(cwd), null);

  logger.saveTelemetryOptIn(cwd, true);
  assert.equal(logger.getTelemetryOptIn(cwd), true);

  logger.saveTelemetryOptIn(cwd, false);
  assert.equal(logger.getTelemetryOptIn(cwd), false);
});

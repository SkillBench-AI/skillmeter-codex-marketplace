"use strict";

/**
 * Explicit repository consent and scope boundaries.
 * Consent messaging stays in the hook output; no OS dialog is used.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "sk-consent-home-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.PLUGIN_DATA = path.join(tmpHome, "plugin-data");

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
  assert.deepEqual(logger.resolveTelemetryGate(false, true), {
    capture: false,
    mode: "opted_out",
  });
  assert.deepEqual(logger.resolveTelemetryGate(false, false), {
    capture: false,
    mode: "opted_out",
  });
});

test("resolveTelemetryGate: explicit opt-in cannot widen ownership scope", () => {
  assert.deepEqual(logger.resolveTelemetryGate(true, true), {
    capture: true,
    mode: "opted_in",
  });
  assert.deepEqual(logger.resolveTelemetryGate(true, false), {
    capture: false,
    mode: "out_of_scope",
  });
});

test("resolveTelemetryGate: unset never authorizes capture", () => {
  assert.deepEqual(logger.resolveTelemetryGate(null, true), {
    capture: false,
    mode: "not_enabled",
  });
  assert.deepEqual(logger.resolveTelemetryGate(null, false), {
    capture: false,
    mode: "out_of_scope",
  });
});

test("defaultGateMessaging: out-of-scope capture is reported", () => {
  const original = console.error;
  const lines = [];
  console.error = (msg) => lines.push(msg);
  try {
    logger.defaultGateMessaging("PreToolUse", { capture: false, mode: "out_of_scope" });
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /out of scope/);
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

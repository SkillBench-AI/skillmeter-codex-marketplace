"use strict";

/**
 * Unit tests for cross-platform telemetry consent UX (SBEE-157).
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

test("macOS consent dialog enables telemetry when the user chooses Yes", () => {
  const cwd = makeProject();
  const calls = [];

  const enabled = logger.promptTelemetryOptIn(cwd, {
    platform: "darwin",
    stderr: stderrSink().stream,
    runConsentCommand: (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: "button returned:Yes\n", stderr: "" };
    },
  });

  assert.equal(enabled, true);
  assert.equal(logger.getTelemetryOptIn(cwd), true);
  assert.equal(calls[0].command, "osascript");
  assert.match(calls[0].args.join(" "), /SkillMeter/);
});

test("Windows consent dialog disables telemetry when the user chooses No", () => {
  const cwd = makeProject();
  const calls = [];

  const enabled = logger.promptTelemetryOptIn(cwd, {
    platform: "win32",
    stderr: stderrSink().stream,
    runConsentCommand: (command, args) => {
      calls.push({ command, args });
      return command === "powershell.exe"
        ? { status: null, stdout: "", stderr: "", error: new Error("missing") }
        : { status: 0, stdout: "No\n", stderr: "" };
    },
  });

  assert.equal(enabled, false);
  assert.equal(logger.getTelemetryOptIn(cwd), false);
  assert.deepEqual(calls.map((call) => call.command), ["powershell.exe", "pwsh"]);
  assert.match(calls[1].args.join(" "), /MessageBox/);
});

test("Linux consent dialog uses desktop prompts when a display is available", () => {
  const yes = logger.resolveTelemetryConsent("linux", {
    env: { DISPLAY: ":0" },
    runConsentCommand: (command) => {
      assert.equal(command, "zenity");
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const no = logger.resolveTelemetryConsent("linux", {
    env: { WAYLAND_DISPLAY: "wayland-0" },
    runConsentCommand: () => ({ status: 1, stdout: "", stderr: "" }),
  });

  assert.equal(yes, true);
  assert.equal(no, false);
});

test("headless consent fallback prints in-Codex commands without saving a decision", () => {
  const cwd = makeProject();
  const sink = stderrSink();

  const enabled = logger.promptTelemetryOptIn(cwd, {
    platform: "linux",
    env: {},
    stderr: sink.stream,
    runConsentCommand: () => {
      throw new Error("headless Linux should not launch a dialog");
    },
  });

  assert.equal(enabled, false);
  assert.equal(logger.getTelemetryOptIn(cwd), null);
  assert.match(sink.output(), /Telemetry is not configured/);
  assert.match(sink.output(), /telemetry\.js" enable/);
  assert.match(sink.output(), /telemetry\.js" disable/);
  assert.match(sink.output(), /telemetry\.js" status/);
});

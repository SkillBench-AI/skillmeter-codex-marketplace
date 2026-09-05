"use strict";

// Catalog verified 2026-09-05 against https://learn.chatgpt.com/docs/hooks.
// SessionEnd and Interrupt are now supported with a three-second maximum.

const fs = require("fs");
const path = require("path");

const { test } = require("node:test");
const assert = require("node:assert/strict");

const PLUGIN_DIR = path.join(__dirname, "..");

// The authoritative, verified Codex hook catalog (12 events).
const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "Interrupt",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "Stop",
].sort();

// Events that exist in the Claude plugin but NOT in the Codex catalog. Wiring
// any of these would be dead config (Codex will never emit them), so they must
// stay out of hooks.json until Codex actually ships them.
const NON_CODEX_EVENTS = [
  "Notification",
  "PermissionDenied",
  "TaskCreated",
  "TaskCompleted",
  "WorktreeCreate",
  "WorktreeRemove",
  "TeammateIdle",
  "InstructionsLoaded",
  "ConfigChange",
  "PostToolBatch",
  "PostToolUseFailure",
  "StopFailure",
  "UserPromptExpansion",
];

function loadHooks() {
  const raw = fs.readFileSync(path.join(PLUGIN_DIR, "hooks", "hooks.json"), "utf8");
  return JSON.parse(raw).hooks;
}

test("hooks.json wires exactly the verified Codex hook catalog (all 12 events)", () => {
  const wired = Object.keys(loadHooks()).sort();
  assert.deepEqual(
    wired,
    CODEX_HOOK_EVENTS,
    "hooks.json must handle every Codex lifecycle event and nothing else"
  );
});

test("hooks.json does not wire any Claude-only event absent from Codex", () => {
  const wired = new Set(Object.keys(loadHooks()));
  for (const event of NON_CODEX_EVENTS) {
    assert.equal(
      wired.has(event),
      false,
      `${event} is not in the Codex hook catalog and must not be wired`
    );
  }
});

test("every wired hook points at an existing handler script", () => {
  const hooks = loadHooks();
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        assert.equal(hook.type, "command", `${event}: expected a command hook`);
        const match = hook.command.match(/scripts\/([A-Za-z0-9_]+\.js)/);
        assert.ok(match, `${event}: command must invoke a scripts/*.js handler`);
        const scriptPath = path.join(PLUGIN_DIR, "scripts", match[1]);
        assert.ok(
          fs.existsSync(scriptPath),
          `${event}: handler ${match[1]} is missing on disk`
        );
      }
    }
  }
});

test("shutdown hooks use the documented three-second maximum", () => {
  for (const event of ["SessionEnd", "Interrupt"]) {
    assert.equal(loadHooks()[event][0].hooks[0].timeout, 3);
  }
});

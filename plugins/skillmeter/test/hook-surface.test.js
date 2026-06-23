"use strict";

/**
 * Hook-surface parity guard (SBEE-159).
 *
 * The Codex epic flagged that SkillMeter's hook surface is smaller than the
 * Claude plugin's (no Notification, SessionEnd, task/worktree/permission-denied
 * events) and asked us to "verify against the current Codex hook catalog and
 * wire any that do" exist.
 *
 * Verification result (OpenAI Codex hooks docs — https://developers.openai.com/codex/hooks):
 * the post-GA Codex CLI exposes exactly TEN lifecycle hook events. There is no
 * SessionEnd hook (only an open upstream request — openai/codex#20603), and no
 * Notification / PermissionDenied / TaskCreated / TaskCompleted / WorktreeCreate
 * / WorktreeRemove / TeammateIdle event — those are Claude-Code-only. So there is
 * nothing additional to wire; the correct state is "all ten Codex events are
 * handled".
 *
 * This test pins that contract: it fails if hooks.json drifts away from the
 * full, verified Codex catalog (an event is dropped, a non-existent event is
 * added, or a script path goes missing), so the parity claim stays honest as
 * Codex evolves.
 *
 * Run with:  node --test plugins/skillmeter/test/hook-surface.test.js
 */

const fs = require("fs");
const path = require("path");

const { test } = require("node:test");
const assert = require("node:assert/strict");

const PLUGIN_DIR = path.join(__dirname, "..");

// The authoritative, verified Codex hook catalog (10 events).
const CODEX_HOOK_EVENTS = [
  "SessionStart",
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
  "SessionEnd",
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

test("hooks.json wires exactly the verified Codex hook catalog (all 10 events)", () => {
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

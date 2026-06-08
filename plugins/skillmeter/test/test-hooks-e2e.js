#!/usr/bin/env node
/**
 * End-to-end hook test for the SkillMeter Codex plugin.
 *
 * What it does:
 *   1. Spins up a local HTTP capture server on a random port.
 *   2. Points SKILLMETER_BACKEND_URL at that server.
 *   3. Drives every hook script (10 events) with a realistic Codex payload
 *      via stdin, exactly the way Codex itself spawns plugin hooks.
 *   4. Waits for the Stop hook to flush, then prints the captured POST:
 *      method, path, headers, decompressed NDJSON body.
 *
 * What it isolates from your real machine:
 *   - HOME is redirected to a temp dir, so credstore creates its own
 *     ~/.skillbench/credentials.json under the temp dir instead of touching
 *     your real one.
 *   - PLUGIN_DATA is a separate temp dir, so the NDJSON log file doesn't
 *     mingle with anything else.
 *   - The "project" cwd is a temp dir with telemetry opted-in.
 *
 * Run from anywhere:
 *   node plugins/skillmeter/test/test-hooks-e2e.js
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");

const PLUGIN_ROOT = path.resolve(__dirname, "..");

// -----------------------------------------------------------------------------
// Capture server
// -----------------------------------------------------------------------------

const captures = [];

function startCaptureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        let decoded = raw;
        if ((req.headers["content-encoding"] || "").includes("gzip")) {
          try {
            decoded = zlib.gunzipSync(raw);
          } catch (e) {
            decoded = Buffer.from(`<gunzip failed: ${e.message}>`);
          }
        }
        captures.push({
          method: req.method,
          path: req.url,
          headers: req.headers,
          gzipBytes: raw.length,
          decoded: decoded.toString("utf8"),
        });
        res.statusCode = 202;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ message: "accepted" }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

// -----------------------------------------------------------------------------
// Fake project + isolated HOME
// -----------------------------------------------------------------------------

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skm-codex-test-"));
}

function setupProject(projectDir) {
  fs.mkdirSync(path.join(projectDir, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, ".codex", "settings.local.json"),
    JSON.stringify({ skillmeter: { telemetry: true } }, null, 2) + "\n"
  );
}

// -----------------------------------------------------------------------------
// Drive a single hook script
// -----------------------------------------------------------------------------

function runHookScript(scriptName, payload, env) {
  return new Promise((resolve) => {
    const scriptPath = path.join(PLUGIN_ROOT, "scripts", scriptName);
    const child = spawn("node", [scriptPath], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      resolve({ script: scriptName, code, stdout, stderr });
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

// -----------------------------------------------------------------------------
// Realistic Codex hook payloads (shapes per OpenAI Codex hook docs)
// -----------------------------------------------------------------------------

function buildPayloads(projectDir) {
  const base = {
    session_id: "01997a8b-3c4d-7e5f-8a9b-c0d1e2f3a4b5",
    cwd: projectDir,
    permission_mode: "default",
    model: "gpt-5-codex",
    transcript_path: null,
  };
  const turn = "01997a8b-3c4d-7e5f-8a9b-c0d1e2f3a4b6";

  return [
    {
      script: "session_start.js",
      payload: {
        ...base,
        hook_event_name: "SessionStart",
        source: "startup",
      },
    },
    {
      script: "user_prompt_submit.js",
      payload: {
        ...base,
        hook_event_name: "UserPromptSubmit",
        turn_id: turn,
        prompt: "Refactor the login flow to use the new auth client.",
      },
    },
    {
      script: "pre_tool_use.js",
      payload: {
        ...base,
        hook_event_name: "PreToolUse",
        turn_id: turn,
        tool_name: "Bash",
        tool_use_id: "tu-bash-1",
        tool_input: { command: "rg -n 'loginFlow' src/" },
      },
    },
    {
      script: "permission_request.js",
      payload: {
        ...base,
        hook_event_name: "PermissionRequest",
        turn_id: turn,
        tool_name: "Bash",
        tool_input: {
          command: "git push origin main",
          description: "Push refactor branch",
        },
      },
    },
    {
      script: "post_tool_use.js",
      payload: {
        ...base,
        hook_event_name: "PostToolUse",
        turn_id: turn,
        tool_name: "apply_patch",
        tool_use_id: "tu-patch-1",
        tool_input: {
          patch: "*** Begin Patch\n*** Update File: src/login.ts\n@@\n-old()\n+new()\n*** End Patch",
        },
        tool_response: {
          file_path: path.join(projectDir, "src", "login.ts"),
          status: "ok",
          lines_changed: 2,
        },
      },
    },
    {
      script: "pre_compact.js",
      payload: {
        ...base,
        hook_event_name: "PreCompact",
        turn_id: turn,
        trigger: "auto",
      },
    },
    {
      script: "post_compact.js",
      payload: {
        ...base,
        hook_event_name: "PostCompact",
        turn_id: turn,
        trigger: "auto",
      },
    },
    {
      script: "subagent_start.js",
      payload: {
        ...base,
        hook_event_name: "SubagentStart",
        turn_id: turn,
        agent_id: "sa-1",
        agent_type: "explore",
      },
    },
    {
      script: "subagent_stop.js",
      payload: {
        ...base,
        hook_event_name: "SubagentStop",
        turn_id: turn,
        agent_id: "sa-1",
        agent_type: "explore",
        agent_transcript_path: null,
        stop_hook_active: false,
        last_assistant_message: "Subagent done.",
      },
    },
    {
      script: "stop.js",
      payload: {
        ...base,
        hook_event_name: "Stop",
        turn_id: turn,
        stop_hook_active: false,
        last_assistant_message: "All done. Refactored 2 files.",
      },
    },
  ];
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  const fakeHome = mktmp();
  const pluginData = mktmp();
  const projectDir = mktmp();
  setupProject(projectDir);

  const { server, port } = await startCaptureServer();
  const backendUrl = `http://127.0.0.1:${port}/logs/codex`;

  const env = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    PLUGIN_ROOT,
    PLUGIN_DATA: pluginData,
    SKILLMETER_BACKEND_URL: backendUrl,
    SKILLMETER_TIMEOUT: "5",
  };

  console.log("┌─ test environment ───────────────────────────────────────────");
  console.log("│ PLUGIN_ROOT          :", PLUGIN_ROOT);
  console.log("│ PLUGIN_DATA          :", pluginData);
  console.log("│ project (cwd)        :", projectDir);
  console.log("│ fake HOME            :", fakeHome);
  console.log("│ SKILLMETER_BACKEND_URL:", backendUrl);
  console.log("└──────────────────────────────────────────────────────────────");
  console.log();

  const payloads = buildPayloads(projectDir);
  const results = [];

  for (const { script, payload } of payloads) {
    const result = await runHookScript(script, payload, env);
    results.push(result);
  }

  // Stop's afterLog awaits the fetch promise, but the abort timeout may also
  // race — give the capture server a moment in case anything is in flight.
  await new Promise((r) => setTimeout(r, 300));

  console.log("=== Per-hook execution summary ===");
  for (const r of results) {
    console.log(`\n[${r.script}] exit=${r.code}`);
    if (r.stdout.trim()) console.log("  stdout:", r.stdout.trim());
    if (r.stderr.trim()) {
      console.log(
        "  stderr:",
        r.stderr
          .trim()
          .split("\n")
          .map((l, i) => (i === 0 ? l : "          " + l))
          .join("\n")
      );
    }
  }

  console.log("\n=== Captured HTTP requests ===");
  if (captures.length === 0) {
    console.log("(none — Stop did not POST anything; check stderr above)");
  } else {
    for (const [i, cap] of captures.entries()) {
      console.log(`\n--- Request #${i + 1} ---`);
      console.log(`${cap.method} ${cap.path}`);
      const headerKeys = Object.keys(cap.headers).sort();
      for (const k of headerKeys) {
        // Hide host (random port) and connection noise; keep the meaningful ones.
        if (k === "host" || k === "connection") continue;
        console.log(`${k}: ${cap.headers[k]}`);
      }
      console.log(`(gzipped body: ${cap.gzipBytes} bytes; decoded follows)`);
      console.log("---- begin NDJSON body ----");
      for (const line of cap.decoded.split("\n")) {
        if (!line) continue;
        try {
          console.log(JSON.stringify(JSON.parse(line), null, 2));
        } catch {
          console.log(line);
        }
      }
      console.log("---- end NDJSON body ----");
    }
  }

  server.close();

  // Cleanup temp dirs
  for (const dir of [fakeHome, pluginData, projectDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }

  // Exit non-zero if Stop didn't produce a request — that's a regression.
  const stopProduced = captures.some((c) => c.method === "POST");
  process.exit(stopProduced ? 0 : 1);
}

main().catch((err) => {
  console.error("test runner failed:", err);
  process.exit(2);
});

"use strict";

/**
 * Unit + end-to-end tests for pre-upload content sanitization (SBEE-155).
 * Run with:  node --test plugins/skillmeter/test/sanitization.test.js
 *
 * Two layers are covered:
 *   1. The deterministic detector library in scripts/sanitizer.js — Tier 1
 *      secret redaction, Tier 2 email redaction, recursive walking, the
 *      placeholder allow-list, transcript scrubbing, and the no-original-value
 *      metadata contract.
 *   2. An end-to-end check that the live lifecycle hooks (user_prompt_submit,
 *      post_tool_use, permission_request) actually route raw `prompt`,
 *      `tool_response`, and approval `description` content through that boundary
 *      before writing the durable event log — i.e. a seeded secret never lands
 *      on disk in the queue that gets uploaded.
 *
 * As with the other suites, state is isolated by pointing HOME at a throwaway
 * dir so the shared ~/.skillbench/credentials.json is never touched.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const { test } = require("node:test");
const assert = require("node:assert/strict");

const sanitizer = require("../scripts/sanitizer");

// Fake, non-functional secrets used purely as detector fixtures. None are real.
const FAKE = {
  githubClassic: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  githubPat: "github_pat_11ABCDE0000aBcDeFgHiJ_KLMNOPqrstuvWXYZ0123456789abcdef",
  openai: "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd",
  anthropic: "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  google: "AIza" + "Sy0123456789abcdefghijklmnopqrstuvw", // AIza + 35 chars
  aws: "AKIAIOSFODNN7EXAMPLE", // AKIA + 16 chars (canonical fake)
  slack: "xoxb-1234567890-ABCDEFGHIJKLMNOP",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
};

const PRIVATE_KEY =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234567890abcdef\nQEFAAOCAQ8AMIIBCgKCAQEA\n-----END RSA PRIVATE KEY-----";

const R = sanitizer.SECRET_PLACEHOLDER;
const E = sanitizer.EMAIL_PLACEHOLDER;

// --- Tier 1 detectors ------------------------------------------------------

test("redactString catches every seeded Tier 1 token type", () => {
  for (const [label, secret] of Object.entries(FAKE)) {
    const { value, redactions } = sanitizer.redactString(`prefix ${secret} suffix`);
    assert.equal(
      value.includes(secret),
      false,
      `${label}: raw secret survived sanitization`
    );
    assert.ok(value.includes(R), `${label}: expected redaction placeholder`);
    assert.ok(redactions.length >= 1, `${label}: expected a redaction event`);
    assert.ok(
      redactions.every((r) => r.tier === "tier1"),
      `${label}: token should be tier1`
    );
  }
});

test("redactString redacts multi-line PEM private key blocks whole", () => {
  const { value, redactions } = sanitizer.redactString(
    `here is the key:\n${PRIVATE_KEY}\nthanks`
  );
  assert.equal(value.includes("BEGIN RSA PRIVATE KEY"), false);
  assert.ok(value.includes(R));
  assert.ok(redactions.some((r) => r.type === "private_key"));
});

test("redactString keeps the variable name but redacts .env style values", () => {
  const { value } = sanitizer.redactString('DATABASE_PASSWORD="hunter2supersecret"');
  assert.match(value, /^DATABASE_PASSWORD=/);
  assert.equal(value.includes("hunter2supersecret"), false);
  assert.ok(value.includes(R));
});

test("redactString keeps the scheme word but redacts Authorization credentials", () => {
  const { value } = sanitizer.redactString(
    "Authorization: Bearer abcdef0123456789ABCDEF"
  );
  assert.match(value, /Authorization:\s*Bearer /);
  assert.equal(value.includes("abcdef0123456789ABCDEF"), false);
  assert.ok(value.includes(R));
});

test("redactString redacts credentials embedded in database URLs", () => {
  const { value } = sanitizer.redactString(
    "postgres://admin:s3cr3tpw@db.internal:5432/app"
  );
  assert.equal(value.includes("s3cr3tpw"), false);
  assert.ok(value.includes(R));
});

// --- allow-list (false-positive control) -----------------------------------

test("redactString leaves obvious placeholders untouched", () => {
  for (const sample of [
    "API_KEY=example",
    "TOKEN=dummy",
    "PASSWORD=changeme",
    "SECRET=xxxxxxxx",
  ]) {
    const { value, redactions } = sanitizer.redactString(sample);
    assert.equal(value, sample, `${sample} should not be redacted`);
    assert.equal(redactions.length, 0);
  }
});

test("redactString leaves ordinary prose alone", () => {
  const prose = "Refactor the billing module and add a retry around the API call.";
  const { value, redactions } = sanitizer.redactString(prose);
  assert.equal(value, prose);
  assert.equal(redactions.length, 0);
});

// --- Tier 2 emails ---------------------------------------------------------

test("redactString redacts emails as Tier 2", () => {
  const { value, redactions } = sanitizer.redactString(
    "ping alice.smith@acme-corp.com about the bug"
  );
  assert.equal(value.includes("alice.smith@acme-corp.com"), false);
  assert.ok(value.includes(E));
  assert.ok(redactions.some((r) => r.type === "email" && r.tier === "tier2"));
});

// --- recursive walking -----------------------------------------------------

test("redactDeep scrubs strings nested in objects and arrays", () => {
  const input = {
    prompt: `deploy with ${FAKE.openai}`,
    tool_input: {
      description: "run the script",
      args: ["--token", FAKE.githubClassic],
      nested: { note: "email me at dev@example.org" },
    },
    count: 3,
    flag: true,
  };
  const redactions = [];
  const out = sanitizer.redactDeep(input, redactions);

  assert.equal(JSON.stringify(out).includes(FAKE.openai), false);
  assert.equal(JSON.stringify(out).includes(FAKE.githubClassic), false);
  assert.equal(JSON.stringify(out).includes("dev@example.org"), false);
  // Non-string leaves pass through untouched.
  assert.equal(out.count, 3);
  assert.equal(out.flag, true);
  assert.ok(redactions.length >= 3);
});

// --- metadata contract: never leak the original value ----------------------

test("sanitizeEventData returns counts/types only, never original secrets", () => {
  const { value, meta } = sanitizer.sanitizeEventData({
    last_assistant_message: `done. key was ${FAKE.aws} and ping bob@x.io`,
  });

  assert.equal(value.last_assistant_message.includes(FAKE.aws), false);
  assert.equal(value.last_assistant_message.includes("bob@x.io"), false);

  assert.equal(meta.policyVersion, sanitizer.POLICY_VERSION);
  assert.equal(meta.tier1, 1);
  assert.equal(meta.tier2, 1);
  assert.deepEqual(meta.types.includes("aws_access_key"), true);

  // The metadata blob must not embed any original sensitive value.
  const metaStr = JSON.stringify(meta);
  assert.equal(metaStr.includes(FAKE.aws), false);
  assert.equal(metaStr.includes("bob@x.io"), false);
});

test("containsTier1 is a fail-closed boolean check", () => {
  assert.equal(sanitizer.containsTier1(`x ${FAKE.google}`), true);
  assert.equal(sanitizer.containsTier1("just a normal sentence"), false);
});

// --- transcript scrubbing --------------------------------------------------

test("sanitizeTranscript hashes cwd and redacts secrets in every line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sk-sani-tx-"));
  const txPath = path.join(dir, "rollout.jsonl");
  const lines = [
    JSON.stringify({ type: "session_meta", cwd: "/Users/dev/secret-project" }),
    JSON.stringify({ type: "message", role: "user", text: `use ${FAKE.openai}` }),
    JSON.stringify({
      type: "function_call_output",
      output: `connected to postgres://u:p4ss@db/app, contact dev@example.com`,
    }),
    "this is not json and should be dropped",
  ].join("\n");
  fs.writeFileSync(txPath, lines + "\n");

  const buf = sanitizer.sanitizeTranscript(txPath, "deadbeefsalt");
  const text = buf.toString("utf8");

  assert.equal(text.includes("/Users/dev/secret-project"), false, "cwd hashed");
  assert.equal(text.includes(FAKE.openai), false, "prompt secret redacted");
  assert.equal(text.includes("p4ss@db"), false, "db creds redacted");
  assert.equal(text.includes("dev@example.com"), false, "email redacted");
  assert.ok(text.includes(R));

  // Every emitted line is still valid JSON (malformed line dropped, others kept).
  const out = text.split("\n").filter(Boolean);
  assert.equal(out.length, 3);
  for (const l of out) JSON.parse(l);
});

// --- end-to-end: hooks route raw content through the boundary --------------

// Builds an isolated HOME (with seeded credentials + allowed org) and a git
// repo whose remote is in-scope, runs a hook script with the given stdin
// payload, and returns the parsed records written to the durable event log.
function runHookEndToEnd(script, input) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sk-sani-home-"));
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "sk-sani-data-"));

  fs.mkdirSync(path.join(home, ".skillbench"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".skillbench", "credentials.json"),
    JSON.stringify({
      device_id: "TEST-DEVICE",
      hash_salt: "deadbeefsalt",
      allowed_github_orgs: ["acme"],
    }) + "\n"
  );

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sk-sani-repo-"));
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".git", "config"),
    '[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n'
  );
  fs.mkdirSync(path.join(repo, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".codex", "settings.local.json"),
    JSON.stringify({ skillmeter: { telemetry: true } }) + "\n"
  );

  const scriptPath = path.join(__dirname, "..", "scripts", script);
  const res = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify({ session_id: "sess-1", cwd: repo, ...input }),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PLUGIN_DATA: pluginData,
    },
  });

  // Records may be in the active log or a sealed batch; read whichever exist.
  const logDir = path.join(pluginData, "logs");
  const records = [];
  if (fs.existsSync(logDir)) {
    for (const f of fs.readdirSync(logDir)) {
      if (!/^events\.jsonl(\.\d+)?$/.test(f)) continue;
      const raw = fs.readFileSync(path.join(logDir, f), "utf8");
      for (const line of raw.split("\n")) {
        if (line.trim()) {
          try { records.push(JSON.parse(line)); } catch {}
        }
      }
    }
  }
  return { res, records };
}

test("UserPromptSubmit hook redacts a secret in the raw prompt before logging", () => {
  const { records } = runHookEndToEnd("user_prompt_submit.js", {
    prompt: `Here is my key ${FAKE.githubClassic}, please use it`,
  });
  const rec = records.find((r) => r.hook_event_name === "UserPromptSubmit");
  assert.ok(rec, "expected a UserPromptSubmit record");
  const blob = JSON.stringify(rec);
  assert.equal(blob.includes(FAKE.githubClassic), false, "raw token reached the queue");
  assert.ok(rec.data.prompt.includes(R));
  assert.ok(rec.data._sanitization && rec.data._sanitization.tier1 >= 1);
});

test("PostToolUse hook redacts secrets in tool_response before logging", () => {
  const { records } = runHookEndToEnd("post_tool_use.js", {
    tool_name: "Bash",
    tool_use_id: "t1",
    tool_input: { command: "cat .env" },
    tool_response: { stdout: `OPENAI_API_KEY=${FAKE.openai}\nDONE` },
  });
  const rec = records.find((r) => r.hook_event_name === "PostToolUse");
  assert.ok(rec, "expected a PostToolUse record");
  const blob = JSON.stringify(rec);
  assert.equal(blob.includes(FAKE.openai), false, "raw key reached the queue");
  assert.ok(blob.includes(R));
});

test("PermissionRequest hook redacts secrets in the approval description", () => {
  const { records } = runHookEndToEnd("permission_request.js", {
    tool_name: "Bash",
    tool_input: { description: `run deploy with token ${FAKE.slack}` },
  });
  const rec = records.find((r) => r.hook_event_name === "PermissionRequest");
  assert.ok(rec, "expected a PermissionRequest record");
  const blob = JSON.stringify(rec);
  assert.equal(blob.includes(FAKE.slack), false, "raw token reached the queue");
  assert.ok(rec.data.description.includes(R));
});

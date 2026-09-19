"use strict";

/**
 * Detector and hook-to-queue sanitization tests using synthetic secrets.
 * Keep HOME isolated from real credentials.
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
  githubPat: "github_pat_" + require("./fixtures/secret-corpus.json").hi.slice(0, 82),
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
      redactions.every((r) => r.category === "secret"),
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
  assert.ok(redactions.some((r) => r.id === "private-key"));
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
  assert.ok(redactions.some((r) => r.kind === "email" && r.category === "pii"));
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
  assert.equal(meta.secrets, 1);
  assert.equal(meta.pii, 1);
  assert.deepEqual(meta.ids.includes("aws-access-token"), true);

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
  ].join("\n");
  fs.writeFileSync(txPath, lines + "\n");

  const buf = sanitizer.sanitizeTranscript(txPath, "deadbeefsalt");
  const text = buf.toString("utf8");

  assert.equal(text.includes("/Users/dev/secret-project"), false, "cwd hashed");
  assert.equal(text.includes(FAKE.openai), false, "prompt secret redacted");
  assert.equal(text.includes("p4ss@db"), false, "db creds redacted");
  assert.equal(text.includes("dev@example.com"), false, "email redacted");
  assert.ok(text.includes(R));

  // Every emitted line is still valid JSON. Malformed records fail explicitly.
  const out = text.split("\n").filter(Boolean);
  assert.equal(out.length, 3);
  for (const l of out) JSON.parse(l);
  fs.appendFileSync(txPath, "not json\n");
  assert.throws(() => sanitizer.sanitizeTranscript(txPath, "deadbeefsalt"), SyntaxError);
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
      license_jwt: "e30." + Buffer.from(JSON.stringify({exp:4102444800, github_id:123, org:{login:"acme"}, aud:"https://acme.meter.skillbench.com"})).toString("base64url") + ".fixture",
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
  assert.ok(rec.data._sanitization && rec.data._sanitization.secrets >= 1);
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

// Shared secret corpus: preserve detector coverage across client implementations.
const SECRET_CORPUS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "secret-corpus.json"), "utf8")
);
const buildCorpusValue = (parts) =>
  parts
    .map((p) => {
      if (/^HI[0-9]+$/.test(p)) return SECRET_CORPUS.hi.slice(0, Number(p.slice(2)));
      if (/^HX[0-9]+$/.test(p)) return SECRET_CORPUS.hex.slice(0, Number(p.slice(2)));
      return p;
    })
    .join("");

test("shared corpus: version + size guard (no silent shrinkage)", () => {
  assert.equal(SECRET_CORPUS.version, "1", "corpus version changed — re-sync all repo copies");
  const tier1 = SECRET_CORPUS.fixtures.filter((f) => f.tier === "tier1");
  assert.ok(tier1.length >= 24, `expected >= 24 Tier-1 fixtures, got ${tier1.length}`);
  assert.ok(
    SECRET_CORPUS.fixtures.some((f) => f.tier === "tier2"),
    "expected at least one Tier-2 fixture"
  );
});

for (const f of SECRET_CORPUS.fixtures) {
  test(`shared corpus: ${f.tier} ${f.id} is redacted`, () => {
    const secret = buildCorpusValue(f.parts);
    const { value, redactions } = sanitizer.redactString(`prefix ${secret} suffix`);
    assert.ok(redactions.length > 0, `${f.id}: expected a redaction event`);
    assert.equal(value.includes(secret), false, `${f.id}: raw secret survived sanitization`);
  });
}

// --- Key-name forced redaction (scrubDeep parity) --------------------------
// A string under a secret-labelled key must be redacted even when it matches
// no detector, matching the Claude / session-collector sanitizers.
test("redactDeep forces redaction on a secret-labelled object key", () => {
  const { value } = sanitizer.sanitizeEventData({
    mcp: { env: { API_KEY: "someRealLookingValue123" } },
  });
  assert.equal(value.mcp.env.API_KEY, "[REDACTED_SECRET]");
});

test("redactDeep leaves obvious placeholder values under secret keys in place", () => {
  const { value } = sanitizer.sanitizeEventData({ token: "example" });
  assert.equal(value.token, "example");
});

test("redactDeep forces redaction through arrays under a secret key", () => {
  const { value } = sanitizer.sanitizeEventData({
    tokens: ["plainButUnderTokenKey123", "anotherOpaqueValue456"],
  });
  assert.deepEqual(value.tokens, ["[REDACTED_SECRET]", "[REDACTED_SECRET]"]);
});

test("non-secret keys are not force-redacted", () => {
  const { value } = sanitizer.sanitizeEventData({ description: "deploy the api gateway" });
  assert.equal(value.description, "deploy the api gateway");
});

for (const script of ["pre_tool_use.js", "post_tool_use.js", "permission_request.js"]) {
  test(`${script} sanitizes paths once at the event queue boundary`, () => {
    const toolInput = {
      file_path: "/private/undisclosed/src/customer.ts",
      cwd: "/private/project",
      command: "cat /private/customer.txt",
      note: "用户@example.com",
      "Keep telemetry authorized?": "yes",
    };
    const { res, records } = runHookEndToEnd(script, { tool_name: "read_file", tool_input: toolInput });
    assert.equal(res.status, 0, res.stderr);
    const rec = records.find(r => r.data.tool_name === "read_file");
    assert.ok(rec, "hook record missing");
    const shared = require("../scripts/lib/sanitize");
    assert.equal(rec.data.tool_input.file_path, shared.hashPathSegments(toolInput.file_path, "deadbeefsalt"));
    assert.equal(rec.data.tool_input.cwd, sanitizer.hashHmac(toolInput.cwd, "deadbeefsalt"));
    assert.equal(rec.data.tool_input.command, sanitizer.hashHmac(toolInput.command, "deadbeefsalt"));
    assert.equal(rec.data.tool_input.note, "[EMAIL]");
    assert.equal(rec.data.tool_input["Keep telemetry authorized?"], "yes");
    assert.equal(rec.data._sanitization.policyVersion, "3.1.0");
    assert.equal(rec.data._sanitization.counts.email, 1);
    // One event cwd, three private file segments, tool cwd, and opaque command.
    assert.equal(rec.data._sanitization.counts.path, 6);
    assert.equal(Object.hasOwn(rec.data.tool_input, "_sanitization"), false);
  });
}

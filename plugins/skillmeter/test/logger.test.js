"use strict";

/**
 * Unit tests for two core logger.js functions that were previously uncovered
 * (SBEE-159): the path-hashing pass `sanitizeToolData` and the ingest-endpoint
 * resolver `getBackendUrl`.
 *
 * Run with:  node --test plugins/skillmeter/test/logger.test.js
 *
 * As with the other suites, state is isolated by pointing HOME at a throwaway
 * dir and seeding a device id + hash salt so credstore never reaches for the
 * macOS Keychain. This MUST happen before credstore/logger are required, since
 * CRED_FILE is resolved from os.homedir() at module load.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "sk-logger-home-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

fs.mkdirSync(path.join(tmpHome, ".skillbench"), { recursive: true });
fs.writeFileSync(
  path.join(tmpHome, ".skillbench", "credentials.json"),
  JSON.stringify({ device_id: "TEST-DEVICE", hash_salt: "deadbeefsalt" }) + "\n"
);

// getBackendUrl consults SKILLMETER_BACKEND_URL first; clear any inherited
// value so the env-override tests start from a known state.
delete process.env.SKILLMETER_BACKEND_URL;

const { test } = require("node:test");
const assert = require("node:assert/strict");

const credstore = require("../scripts/credstore");
const logger = require("../scripts/logger");

const SALT = "deadbeefsalt";

// Mint an unsigned JWT (alg:none) carrying the given payload. Only the payload
// is read by the plugin's decode-without-verify routines, so a real signature
// is unnecessary for these routing tests.
function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function futureExp(seconds = 3600) {
  return Math.floor(Date.now() / 1000) + seconds;
}

// --- sanitizeToolData: path-key hashing ------------------------------------

test("sanitizeToolData hashes every path-like key", () => {
  const input = {
    file_path: "/Users/dev/secret/app.ts",
    filePath: "/Users/dev/secret/other.ts",
    path: "/etc/passwd",
    command: "cat ~/.aws/credentials",
    cwd: "/Users/dev/secret-project",
    patch: "*** Update File: /Users/dev/secret/app.ts",
  };
  const out = logger.sanitizeToolData(input, SALT);

  for (const key of Object.keys(input)) {
    assert.notEqual(out[key], input[key], `${key} should be hashed`);
    // 12-char HMAC hex prefix (see hashHmac).
    assert.match(out[key], /^[0-9a-f]{12}$/, `${key} should be a 12-char hex hash`);
    assert.equal(out[key], logger.hashHmac(input[key], SALT), `${key} hash must be deterministic`);
  }
});

test("sanitizeToolData leaves non-path keys untouched", () => {
  const input = {
    tool_name: "Bash",
    description: "run the deploy script",
    count: 3,
    enabled: true,
    nothing: null,
  };
  const out = logger.sanitizeToolData(input, SALT);
  assert.deepEqual(out, input);
});

test("sanitizeToolData recurses into nested objects and arrays", () => {
  const input = {
    tool_input: {
      command: "ls /secret",
      args: [{ path: "/a/b" }, { path: "/c/d" }],
    },
    safe: "keep me",
  };
  const out = logger.sanitizeToolData(input, SALT);

  assert.match(out.tool_input.command, /^[0-9a-f]{12}$/);
  assert.match(out.tool_input.args[0].path, /^[0-9a-f]{12}$/);
  assert.match(out.tool_input.args[1].path, /^[0-9a-f]{12}$/);
  assert.equal(out.safe, "keep me");
});

test("sanitizeToolData only hashes string path values, not numbers/objects", () => {
  const input = {
    command: 42,
    path: { nested: "/a" },
    file_path: "/real/string/path",
  };
  const out = logger.sanitizeToolData(input, SALT);

  // Non-string path values are not hashed wholesale; objects recurse, numbers
  // pass through untouched.
  assert.equal(out.command, 42);
  assert.equal(out.path.nested, "/a");
  assert.match(out.file_path, /^[0-9a-f]{12}$/);
});

test("sanitizeToolData returns non-object inputs unchanged", () => {
  assert.equal(logger.sanitizeToolData(null, SALT), null);
  assert.equal(logger.sanitizeToolData(undefined, SALT), undefined);
  assert.equal(logger.sanitizeToolData("a string", SALT), "a string");
  assert.equal(logger.sanitizeToolData(7, SALT), 7);
});

test("sanitizeToolData produces salt-dependent, non-reversible hashes", () => {
  const a = logger.sanitizeToolData({ command: "rm -rf /" }, "salt-a");
  const b = logger.sanitizeToolData({ command: "rm -rf /" }, "salt-b");
  assert.notEqual(a.command, b.command, "different salts must produce different hashes");
  assert.equal(a.command.includes("rm -rf"), false, "raw command must not survive");
});

// --- getBackendUrl: resolution order + trusted-domain validation -----------

test("getBackendUrl returns a trusted SKILLMETER_BACKEND_URL override", () => {
  const url = "https://api.meter.skillbench.com/logs/codex";
  process.env.SKILLMETER_BACKEND_URL = url;
  try {
    assert.equal(logger.getBackendUrl(process.cwd()), url);
  } finally {
    delete process.env.SKILLMETER_BACKEND_URL;
  }
});

test("getBackendUrl rejects an untrusted env override and falls back to default", () => {
  process.env.SKILLMETER_BACKEND_URL = "https://evil.example.com/logs/codex";
  try {
    assert.equal(logger.getBackendUrl(process.cwd()), logger.DEFAULT_BACKEND_URL);
  } finally {
    delete process.env.SKILLMETER_BACKEND_URL;
  }
});

test("getBackendUrl rejects a non-https env override", () => {
  process.env.SKILLMETER_BACKEND_URL = "http://api.meter.skillbench.com/logs/codex";
  try {
    assert.equal(logger.getBackendUrl(process.cwd()), logger.DEFAULT_BACKEND_URL);
  } finally {
    delete process.env.SKILLMETER_BACKEND_URL;
  }
});

test("getBackendUrl ignores a backendUrl settings key (env/JWT only, like Claude)", () => {
  // Environment selection now lives on the activation side (activate_url); the
  // upload host is read back from the license JWT. A stale `backendUrl` settings
  // entry must not override the JWT-derived per-tenant endpoint.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sk-logger-cwd-"));
  fs.mkdirSync(path.join(cwd, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".codex", "settings.local.json"),
    JSON.stringify({
      skillmeter: { backendUrl: "https://acme.meter.dev.skillbench.com/logs/codex" },
    }) + "\n"
  );
  credstore.setLicenseToken(
    makeJwt({ telemetry_endpoint: "https://jwt.meter.skillbench.com", exp: futureExp() })
  );
  try {
    assert.equal(
      logger.getBackendUrl(cwd),
      "https://jwt.meter.skillbench.com/logs/codex"
    );
  } finally {
    credstore.setLicenseToken("");
  }
});

test("getBackendUrl derives the per-tenant endpoint from a valid license JWT", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sk-logger-cwd-"));
  credstore.setLicenseToken(
    makeJwt({ telemetry_endpoint: "https://acme.meter.skillbench.com", exp: futureExp() })
  );
  try {
    assert.equal(
      logger.getBackendUrl(cwd),
      "https://acme.meter.skillbench.com/logs/codex"
    );
  } finally {
    credstore.setLicenseToken("");
  }
});

test("getBackendUrl trusts a prod skillbench.ai per-tenant endpoint", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sk-logger-cwd-"));
  credstore.setLicenseToken(
    makeJwt({ telemetry_endpoint: "https://acme.meter.skillbench.ai", exp: futureExp() })
  );
  try {
    assert.equal(
      logger.getBackendUrl(cwd),
      "https://acme.meter.skillbench.ai/logs/codex"
    );
  } finally {
    credstore.setLicenseToken("");
  }
});

test("getBackendUrl falls back to default when the JWT endpoint is untrusted", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sk-logger-cwd-"));
  credstore.setLicenseToken(
    makeJwt({ telemetry_endpoint: "https://evil.example.com", exp: futureExp() })
  );
  try {
    assert.equal(logger.getBackendUrl(cwd), logger.DEFAULT_BACKEND_URL);
  } finally {
    credstore.setLicenseToken("");
  }
});

test("getBackendUrl derives the per-tenant endpoint even from an expired license JWT", () => {
  // The telemetry_endpoint claim is routing info, not an auth decision: an
  // expired token still resolves the tenant host so a drain reaches the right
  // collector while a refresh is pending (matches the Claude plugin).
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sk-logger-cwd-"));
  credstore.setLicenseToken(
    makeJwt({ telemetry_endpoint: "https://acme.meter.skillbench.com", exp: futureExp(-3600) })
  );
  try {
    assert.equal(
      logger.getBackendUrl(cwd),
      "https://acme.meter.skillbench.com/logs/codex"
    );
  } finally {
    credstore.setLicenseToken("");
  }
});

test("getBackendUrl falls back to default when an expired JWT endpoint is untrusted", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sk-logger-cwd-"));
  credstore.setLicenseToken(
    makeJwt({ telemetry_endpoint: "https://evil.example.com", exp: futureExp(-3600) })
  );
  try {
    assert.equal(logger.getBackendUrl(cwd), logger.DEFAULT_BACKEND_URL);
  } finally {
    credstore.setLicenseToken("");
  }
});

test("getBackendUrl returns the shipped default when unauthenticated", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sk-logger-cwd-"));
  credstore.setLicenseToken("");
  assert.equal(logger.getBackendUrl(cwd), logger.DEFAULT_BACKEND_URL);
  assert.match(logger.DEFAULT_BACKEND_URL, /^https:\/\/api\.meter\.skillbench\.ai\/logs\/codex$/);
});

test("getBackendUrl env override takes precedence over the JWT", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sk-logger-cwd-"));
  credstore.setLicenseToken(
    makeJwt({ telemetry_endpoint: "https://jwt.meter.skillbench.com", exp: futureExp() })
  );
  const envUrl = "https://api.meter.skillbench.com/logs/codex";
  process.env.SKILLMETER_BACKEND_URL = envUrl;
  try {
    assert.equal(logger.getBackendUrl(cwd), envUrl);
  } finally {
    delete process.env.SKILLMETER_BACKEND_URL;
    credstore.setLicenseToken("");
  }
});

"use strict";

/**
 * Unit tests for the identity/auth flow and JWT-derived endpoint routing
 * (SBEE-152). Run with:  node --test plugins/skillmeter/test/auth.test.js
 *
 * The tests isolate state by pointing HOME at a throwaway directory (so the
 * shared ~/.skillbench/credentials.json is never touched) and seeding a
 * device id + hash salt up front so credstore never reaches for the macOS
 * Keychain. All of this MUST happen before credstore/logger are required,
 * since CRED_FILE is resolved from os.homedir() at module load.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const http = require("http");

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "sk-auth-home-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.SKILLMETER_BACKEND_URL;
delete process.env.SKILLMETER_ACTIVATE_URL;
delete process.env.SKILLMETER_GITHUB_CLIENT_ID;

fs.mkdirSync(path.join(tmpHome, ".skillbench"), { recursive: true });
fs.writeFileSync(
  path.join(tmpHome, ".skillbench", "credentials.json"),
  JSON.stringify({ device_id: "TEST-DEVICE", hash_salt: "deadbeef" }) + "\n"
);

const { test } = require("node:test");
const assert = require("node:assert/strict");

const jwt = require("../scripts/lib/jwt");
const credstore = require("../scripts/credstore");
const logger = require("../scripts/logger");

// --- helpers ---------------------------------------------------------------

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Build a fake (unsigned) JWT with the given payload claims. The signature is a
// dummy — the plugin never verifies it, it only reads claims locally.
function makeJwt(claims) {
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.sig`;
}

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function tmpLogFile(contents) {
  const p = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "sk-auth-log-")),
    "events.jsonl.1700000000000"
  );
  fs.writeFileSync(p, contents);
  return p;
}

// --- lib/jwt ---------------------------------------------------------------

test("decodeJwtPayload returns claims for a well-formed token", () => {
  const payload = jwt.decodeJwtPayload(makeJwt({ sub: "u1", exp: FUTURE }));
  assert.equal(payload.sub, "u1");
  assert.equal(payload.exp, FUTURE);
});

test("decodeJwtPayload returns null for garbage", () => {
  assert.equal(jwt.decodeJwtPayload("not-a-jwt"), null);
  assert.equal(jwt.decodeJwtPayload("a.b"), null);
});

test("isJwtExpired reflects the exp claim", () => {
  assert.equal(jwt.isJwtExpired(makeJwt({ exp: FUTURE })), false);
  assert.equal(jwt.isJwtExpired(makeJwt({ exp: PAST })), true);
});

test("getEndpointFromToken returns the telemetry_endpoint of a valid token", () => {
  const token = makeJwt({ exp: FUTURE, telemetry_endpoint: "https://acme.meter.skillbench.com/" });
  assert.equal(jwt.getEndpointFromToken(token), "https://acme.meter.skillbench.com");
});

test("getEndpointFromToken rejects expired tokens, missing/non-https claims", () => {
  assert.equal(jwt.getEndpointFromToken(makeJwt({ exp: PAST, telemetry_endpoint: "https://acme.meter.skillbench.com" })), null);
  assert.equal(jwt.getEndpointFromToken(makeJwt({ exp: FUTURE })), null);
  assert.equal(jwt.getEndpointFromToken(makeJwt({ exp: FUTURE, telemetry_endpoint: "http://insecure.example.com" })), null);
  assert.equal(jwt.getEndpointFromToken(null), null);
});

// --- credstore lifecycle ---------------------------------------------------

test("commitSignin stores the license + normalized orgs; signOut clears them", () => {
  const token = makeJwt({ exp: FUTURE });
  const ok = credstore.commitSignin({ jwt: token, orgs: ["Acme", "acme", " Beta ", ""] });
  assert.equal(ok, true);
  assert.equal(credstore.getLicenseToken(), token);
  assert.deepEqual(credstore.getAllowedGitHubOrgs(), ["acme", "beta"]);
  assert.equal(credstore.getSignedOut(), false);
  assert.equal(credstore.getTelemetryDisabled(), false);

  credstore.signOut();
  assert.equal(credstore.getLicenseToken(), null);
  assert.deepEqual(credstore.getAllowedGitHubOrgs(), []);
  assert.equal(credstore.getSignedOut(), true);
  assert.equal(credstore.getTelemetryDisabled(), true);
  // device identity survives a sign-out
  assert.equal(credstore.getDeviceId(), "TEST-DEVICE");
});

test("commitSignin is refused while signed out; markEngaged re-arms it", () => {
  credstore.signOut();
  assert.equal(credstore.commitSignin({ jwt: makeJwt({ exp: FUTURE }), orgs: [] }), false);

  credstore.markEngaged();
  assert.equal(credstore.getSignedOut(), false);
  assert.equal(credstore.getTelemetryDisabled(), false);
  assert.equal(credstore.commitSignin({ jwt: makeJwt({ exp: FUTURE }), orgs: ["x"] }), true);
});

test("global telemetry switch blocks event-log uploads without consuming the queue", async () => {
  credstore.setTelemetryDisabled(true);

  let sawRequest = false;
  const srv = await startServer((_req, res) => {
    sawRequest = true;
    res.writeHead(200);
    res.end("ok");
  });
  const logFile = tmpLogFile('{"a":1}\n');

  try {
    const outcome = await logger.transferEventLog(logFile, `${srv.url}/logs/codex`, 5000);
    assert.equal(outcome, "skip");
    assert.equal(sawRequest, false);
    assert.equal(fs.existsSync(logFile), true, "queued batch remains for later");
    assert.equal(fs.existsSync(`${logFile}.sent`), false);
  } finally {
    credstore.setTelemetryDisabled(false);
    try { fs.unlinkSync(logFile); } catch {}
    await srv.close();
  }
});

test("isLicenseTokenExpired treats absent/expired tokens as expired", () => {
  assert.equal(credstore.isLicenseTokenExpired(null), true);
  assert.equal(credstore.isLicenseTokenExpired(makeJwt({ exp: PAST })), true);
  assert.equal(credstore.isLicenseTokenExpired(makeJwt({ exp: FUTURE })), false);
});

test("setLicenseToken('') clears the stored token", () => {
  credstore.setLicenseToken(makeJwt({ exp: FUTURE }));
  assert.notEqual(credstore.getLicenseToken(), null);
  credstore.setLicenseToken("");
  assert.equal(credstore.getLicenseToken(), null);
});

// --- JWT-derived endpoint routing -----------------------------------------

test("getBackendUrl routes to the JWT per-tenant endpoint with /logs/codex", () => {
  credstore.markEngaged();
  credstore.setLicenseToken(makeJwt({ exp: FUTURE, telemetry_endpoint: "https://acme.meter.skillbench.com" }));
  // tmpHome has no .codex/settings.local.json, so settings don't interfere.
  assert.equal(logger.getBackendUrl(tmpHome), "https://acme.meter.skillbench.com/logs/codex");
});

test("getBackendUrl falls back to the prod default when unauthenticated", () => {
  credstore.setLicenseToken("");
  assert.equal(logger.getBackendUrl(tmpHome), logger.DEFAULT_BACKEND_URL);
});

// --- authenticated upload + 401/403 clear-and-retry ------------------------

test("transferEventLog attaches the JWT and marks the batch .sent on 2xx", async () => {
  const token = makeJwt({ exp: FUTURE });
  credstore.setLicenseToken(token);

  let sawAuth = null;
  const srv = await startServer((req, res) => {
    sawAuth = req.headers["authorization"] || null;
    res.writeHead(200);
    res.end("ok");
  });
  const logFile = tmpLogFile('{"a":1}\n');

  try {
    await logger.transferEventLog(logFile, `${srv.url}/logs/codex`, 5000);
    assert.equal(sawAuth, `Bearer ${token}`);
    assert.equal(fs.existsSync(`${logFile}.sent`), true);
    assert.equal(fs.existsSync(logFile), false);
  } finally {
    await srv.close();
  }
});

test("transferEventLog clears the license and retries without auth on 401", async () => {
  const token = makeJwt({ exp: FUTURE });
  credstore.setLicenseToken(token);

  const seen = [];
  const srv = await startServer((req, res) => {
    seen.push(req.headers["authorization"] || null);
    if (seen.length === 1) {
      res.writeHead(401);
      res.end("nope");
    } else {
      res.writeHead(200);
      res.end("ok");
    }
  });
  const logFile = tmpLogFile('{"a":1}\n');

  try {
    await logger.transferEventLog(logFile, `${srv.url}/logs/codex`, 5000);
    assert.equal(seen.length, 2, "should retry exactly once");
    assert.equal(seen[0], `Bearer ${token}`, "first attempt is authenticated");
    assert.equal(seen[1], null, "retry drops the Authorization header");
    assert.equal(credstore.getLicenseToken(), null, "rejected token is cleared");
    assert.equal(fs.existsSync(`${logFile}.sent`), true, "retry success marks batch sent");
  } finally {
    await srv.close();
  }
});

test("transferEventLog drops an expired JWT before sending (no auth header)", async () => {
  credstore.setLicenseToken(makeJwt({ exp: PAST }));

  let sawAuth = "unset";
  const srv = await startServer((req, res) => {
    sawAuth = req.headers["authorization"] || null;
    res.writeHead(200);
    res.end("ok");
  });
  const logFile = tmpLogFile('{"a":1}\n');

  try {
    await logger.transferEventLog(logFile, `${srv.url}/logs/codex`, 5000);
    assert.equal(sawAuth, null, "expired token is not attached");
    assert.equal(fs.existsSync(`${logFile}.sent`), true);
  } finally {
    await srv.close();
  }
});

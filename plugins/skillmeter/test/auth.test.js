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
process.env.PLUGIN_DATA = path.join(tmpHome, "plugin-data");
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
const licenseActivation = require("../scripts/lib/license-activation");

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
      const nativeFetch = global.fetch;
      global.fetch = (url, options) => {
        assert.equal(new URL(url).origin, "https://acme.meter.skillbench.com");
        return nativeFetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, options);
      };
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => { global.fetch = nativeFetch; return new Promise((r) => server.close(r)); },
      });
    });
  });
}

function tmpLogFile(contents) {
  let dir;
  try { dir = require("../testing/authorized-queue").authorizedQueue(logger).root; }
  catch { dir = fs.mkdtempSync(path.join(os.tmpdir(), "sk-auth-log-")); }
  const p = path.join(dir, "events.jsonl." + Date.now());
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

test("getEndpointFromToken returns the `aud` endpoint of a valid token", () => {
  const token = makeJwt({ exp: FUTURE, aud: "https://acme.meter.skillbench.com/" });
  assert.equal(jwt.getEndpointFromToken(token), "https://acme.meter.skillbench.com");
});

test("getEndpointFromToken reads an array `aud`, taking the first https origin", () => {
  const token = makeJwt({ exp: FUTURE, aud: ["skillbench", "https://acme.meter.skillbench.com"] });
  assert.equal(jwt.getEndpointFromToken(token), "https://acme.meter.skillbench.com");
});

test("getEndpointFromToken ignores the legacy telemetry_endpoint claim — `aud` only", () => {
  const token = makeJwt({ exp: FUTURE, aud: "just-an-audience", telemetry_endpoint: "https://legacy.meter.skillbench.com" });
  assert.equal(jwt.getEndpointFromToken(token), null);
});

test("getEndpointFromToken rejects expired tokens, missing/non-https claims", () => {
  assert.equal(jwt.getEndpointFromToken(makeJwt({ exp: PAST, aud: "https://acme.meter.skillbench.com" })), null);
  assert.equal(jwt.getEndpointFromToken(makeJwt({ exp: FUTURE })), null);
  assert.equal(jwt.getEndpointFromToken(makeJwt({ exp: FUTURE, aud: "http://insecure.example.com" })), null);
  assert.equal(jwt.getEndpointFromToken(null), null);
});

// --- credstore lifecycle ---------------------------------------------------

test("commitSignin scope comes from the license, ignoring legacy memberships", () => {
  const token = makeJwt({ exp: FUTURE, aud: "https://acme.meter.skillbench.com", github_id: 123, org: {login:"acme"} });
  const ok = credstore.commitSignin({ jwt: token, orgs: ["Acme", "acme", " Beta ", ""] });
  assert.equal(ok, true);
  assert.equal(credstore.getLicenseToken(), token);
  assert.deepEqual(credstore.getAllowedGitHubOrgs(), ["acme"]);
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
    const outcome = await logger.transferEventLog(logFile, "https://acme.meter.skillbench.com/logs/codex", 5000);
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
  credstore.setLicenseToken(makeJwt({ exp: FUTURE, aud: "https://acme.meter.skillbench.com", github_id: 123, org: {login:"acme"} }));
  // tmpHome has no .codex/settings.local.json, so settings don't interfere.
  assert.equal(logger.getBackendUrl(tmpHome), "https://acme.meter.skillbench.com/logs/codex");
});

test("getBackendUrl falls back to the prod default when unauthenticated", () => {
  credstore.setLicenseToken("");
  assert.equal(logger.getBackendUrl(tmpHome), logger.DEFAULT_BACKEND_URL);
});

// --- activation URL resolution (prod is on skillbench.ai) ------------------

test("activation defaults to the prod skillbench.ai control plane", () => {
  // getActivateUrl reads `skillmeter.activate_url` from <cwd>/.codex; run from a
  // clean dir so this repo's own dev settings.local.json doesn't interfere.
  const prevCwd = process.cwd();
  process.chdir(tmpHome);
  try {
    assert.equal(licenseActivation.getActivateUrl(), "https://api.skillbench.ai/activate");
    assert.equal(licenseActivation.getRefreshUrl(), "https://api.skillbench.ai/refresh");
  } finally {
    process.chdir(prevCwd);
  }
});

test("a trusted skillbench.ai activation override is honored", () => {
  process.env.SKILLMETER_ACTIVATE_URL = "https://api.skillbench.ai/activate";
  try {
    assert.equal(licenseActivation.getActivateUrl(), "https://api.skillbench.ai/activate");
  } finally {
    delete process.env.SKILLMETER_ACTIVATE_URL;
  }
});

test("a trusted dev activation override is honored", () => {
  process.env.SKILLMETER_ACTIVATE_URL = "https://api.dev.skillbench.com/activate";
  try {
    assert.equal(licenseActivation.getActivateUrl(), "https://api.dev.skillbench.com/activate");
  } finally {
    delete process.env.SKILLMETER_ACTIVATE_URL;
  }
});

test("an untrusted activation override falls back to the prod default", () => {
  process.env.SKILLMETER_ACTIVATE_URL = "https://evil.example.com/activate";
  try {
    assert.equal(licenseActivation.getActivateUrl(), "https://api.skillbench.ai/activate");
  } finally {
    delete process.env.SKILLMETER_ACTIVATE_URL;
  }
});

// --- authenticated upload + 401/403 clear-and-retry ------------------------

test("transferEventLog attaches the JWT and marks the batch .sent on 2xx", async () => {
  const token = makeJwt({ exp: FUTURE, aud: "https://acme.meter.skillbench.com", github_id: 123, org: {login:"acme"} });
  credstore.setLicenseToken(token);

  let sawAuth = null;
  const srv = await startServer((req, res) => {
    sawAuth = req.headers["authorization"] || null;
    res.writeHead(200);
    res.end("ok");
  });
  const logFile = tmpLogFile('{"a":1}\n');

  try {
    await logger.transferEventLog(logFile, "https://acme.meter.skillbench.com/logs/codex", 5000);
    assert.equal(sawAuth, `Bearer ${token}`);
    assert.equal(fs.existsSync(`${logFile}.sent`), true);
    assert.equal(fs.existsSync(logFile), false);
  } finally {
    await srv.close();
  }
});

test("transferEventLog retains the license and batch after one authenticated 401", async () => {
  const token = makeJwt({ exp: FUTURE, aud: "https://acme.meter.skillbench.com", github_id: 123, org: {login:"acme"} });
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
    await logger.transferEventLog(logFile, "https://acme.meter.skillbench.com/logs/codex", 5000);
    assert.equal(seen.length, 1, "must not retry anonymously");
    assert.equal(seen[0], `Bearer ${token}`, "first attempt is authenticated");
    assert.equal(credstore.getLicenseToken(), token, "rejected token is retained for recovery");
    assert.equal(fs.existsSync(logFile), true, "auth failure retains the batch");
  } finally {
    await srv.close();
  }
});

test("transferEventLog retains an expired-token batch without any request", async () => {
  credstore.setLicenseToken(makeJwt({ exp: PAST }));

  let sawAuth = "unset";
  const srv = await startServer((req, res) => {
    sawAuth = req.headers["authorization"] || null;
    res.writeHead(200);
    res.end("ok");
  });
  const logFile = tmpLogFile('{"a":1}\n');

  try {
    await logger.transferEventLog(logFile, "https://acme.meter.skillbench.com/logs/codex", 5000);
    assert.equal(sawAuth, "unset", "expired token prevents sending");
    assert.equal(fs.existsSync(logFile), true);
  } finally {
    await srv.close();
  }
});

// --- SessionStart awaits the refresh before the first event -----------------

test("prepareSession refreshes an expired token so the current session is authenticated", async () => {
  const sessionStart = require("../scripts/session_start");

  // Seed an expired license JWT — the state that used to leave the triggering
  // session unauthenticated when the refresh ran fire-and-forget from afterLog.
  const expired = makeJwt({ exp: PAST });
  const fresh = makeJwt({ exp: FUTURE, aud: "https://acme.meter.skillbench.com", github_id: 123, org: {login:"acme"} });
  credstore.setLicenseToken(expired);
  assert.equal(credstore.isLicenseTokenExpired(expired), true);

  // Stub the /refresh round-trip. refreshExpiredJwt POSTs via global fetch and
  // persists payload.token; with fetch mocked, getRefreshUrl's domain gate is
  // irrelevant because nothing touches the network.
  const realFetch = global.fetch;
  let refreshCalls = 0;
  global.fetch = async () => {
    refreshCalls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ token: fresh }),
      text: async () => "",
    };
  };

  try {
    await sessionStart.prepareSession();
  } finally {
    global.fetch = realFetch;
  }

  assert.equal(refreshCalls, 1, "prepareSession awaits exactly one /refresh");
  assert.equal(
    credstore.getLicenseToken(),
    fresh,
    "the rotated token is persisted before the SessionStart event is built"
  );
  assert.equal(credstore.isLicenseTokenExpired(fresh), false);

  // End-to-end: the current session's own SessionStart event now uploads
  // authenticated with the freshly rotated token instead of being dropped as
  // expired (the transferEventLog "drops an expired JWT" path above).
  let sawAuth = null;
  const srv = await startServer((req, res) => {
    sawAuth = req.headers["authorization"] || null;
    res.writeHead(200);
    res.end("ok");
  });
  const logFile = tmpLogFile('{"event":"SessionStart"}\n');
  try {
    await logger.transferEventLog(logFile, "https://acme.meter.skillbench.com/logs/codex", 5000);
    assert.equal(
      sawAuth,
      `Bearer ${fresh}`,
      "SessionStart uploads with the refreshed token"
    );
    assert.equal(fs.existsSync(`${logFile}.sent`), true);
  } finally {
    await srv.close();
  }
});

test("prepareSession is a no-op (no /refresh) when telemetry is globally disabled", async () => {
  const sessionStart = require("../scripts/session_start");
  credstore.setLicenseToken(makeJwt({ exp: PAST }));

  const realFetch = global.fetch;
  let refreshCalls = 0;
  global.fetch = async () => {
    refreshCalls += 1;
    return { ok: true, status: 200, json: async () => ({ token: makeJwt({ exp: FUTURE }) }), text: async () => "" };
  };

  logger.setTelemetryGloballyDisabled(true);
  try {
    await sessionStart.prepareSession();
    assert.equal(refreshCalls, 0, "globally-disabled telemetry never rotates the token");
  } finally {
    logger.setTelemetryGloballyDisabled(false);
    global.fetch = realFetch;
  }
});

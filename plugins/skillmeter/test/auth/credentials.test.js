"use strict";
// Credentials: JWT claims, the credstore lifecycle, tenant routing, activation
// URL trust, and authenticated uploads against a loopback server.
const { isolateHome, makeJwt, tempDir, writeSettings } = require("../../test-support/plugin.cjs");
const tmpHome = isolateHome({ device_id: "TEST-DEVICE", hash_salt: "deadbeef" });
delete process.env.SKILLMETER_BACKEND_URL;
delete process.env.SKILLMETER_ACTIVATE_URL;
delete process.env.SKILLMETER_GITHUB_CLIENT_ID;

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("../../scripts/lib/jwt");
const credstore = require("../../scripts/credstore");
const logger = require("../../scripts/logger");
const licenseActivation = require("../../scripts/lib/license-activation");

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
  const p = path.join(tempDir("sk-auth-log"), "events.jsonl.1700000000000");
  fs.writeFileSync(p, contents);
  return p;
}

test("decodeJwtPayload returns claims for a well-formed token", () => {
  const payload = jwt.decodeJwtPayload(makeJwt({ sub: "u1", exp: FUTURE }));
  assert.equal(payload.sub, "u1");
  assert.equal(payload.exp, FUTURE);
});

test("decodeJwtPayload returns null for garbage", () => {
  assert.equal(jwt.decodeJwtPayload("not-a-jwt"), null);
  assert.equal(jwt.decodeJwtPayload("a.b"), null);
});

test("isJwtExpired and isLicenseTokenExpired reflect the exp claim; an absent token is expired", () => {
  assert.equal(jwt.isJwtExpired(makeJwt({ exp: FUTURE })), false);
  assert.equal(jwt.isJwtExpired(makeJwt({ exp: PAST })), true);
  assert.equal(credstore.isLicenseTokenExpired(null), true);
  assert.equal(credstore.isLicenseTokenExpired(makeJwt({ exp: PAST })), true);
  assert.equal(credstore.isLicenseTokenExpired(makeJwt({ exp: FUTURE })), false);
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
  assert.equal(credstore.getDeviceId(), "TEST-DEVICE", "device identity survives a sign-out");
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

test("setLicenseToken('') clears the stored token", () => {
  credstore.setLicenseToken(makeJwt({ exp: FUTURE }));
  assert.notEqual(credstore.getLicenseToken(), null);
  credstore.setLicenseToken("");
  assert.equal(credstore.getLicenseToken(), null);
});

test("getBackendUrl: a trusted env override wins, then the JWT tenant, then the shipped default", () => {
  credstore.markEngaged();
  const DEFAULT = logger.DEFAULT_BACKEND_URL;
  assert.match(DEFAULT, /^https:\/\/api\.meter\.skillbench\.ai\/logs\/codex$/);
  for (const [name, { env, aud, exp = FUTURE, settings }, expected] of [
    ["trusted env override over the JWT", { env: "https://api.meter.skillbench.com/logs/codex", aud: "https://jwt.meter.skillbench.com" }, "https://api.meter.skillbench.com/logs/codex"],
    ["untrusted env override", { env: "https://evil.example.com/logs/codex" }, DEFAULT],
    ["non-https env override", { env: "http://api.meter.skillbench.com/logs/codex" }, DEFAULT],
    ["JWT tenant on skillbench.com", { aud: "https://acme.meter.skillbench.com" }, "https://acme.meter.skillbench.com/logs/codex"],
    ["JWT tenant on skillbench.ai", { aud: "https://acme.meter.skillbench.ai" }, "https://acme.meter.skillbench.ai/logs/codex"],
    ["expired JWT still routes", { aud: "https://acme.meter.skillbench.com", exp: PAST }, "https://acme.meter.skillbench.com/logs/codex"],
    ["untrusted JWT tenant", { aud: "https://evil.example.com" }, DEFAULT],
    ["a backendUrl settings key is ignored", { aud: "https://jwt.meter.skillbench.com", settings: { backendUrl: "https://acme.meter.dev.skillbench.com/logs/codex" } }, "https://jwt.meter.skillbench.com/logs/codex"],
    ["unauthenticated", {}, DEFAULT],
  ]) {
    const cwd = tempDir("sk-auth-cwd");
    if (settings) writeSettings(cwd, settings);
    credstore.setLicenseToken(aud ? makeJwt({ aud, exp }) : "");
    if (env) process.env.SKILLMETER_BACKEND_URL = env;
    try {
      assert.equal(logger.getBackendUrl(cwd), expected, name);
    } finally {
      delete process.env.SKILLMETER_BACKEND_URL;
      credstore.setLicenseToken("");
    }
  }
});

test("activation defaults to the prod skillbench.ai control plane", () => {
  // getActivateUrl reads <cwd>/.codex settings; run from a clean directory.
  const prevCwd = process.cwd();
  process.chdir(tmpHome);
  try {
    assert.equal(licenseActivation.getActivateUrl(), "https://api.skillbench.ai/activate");
    assert.equal(licenseActivation.getRefreshUrl(), "https://api.skillbench.ai/refresh");
  } finally {
    process.chdir(prevCwd);
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

// The credential file is shared with the Claude Code plugin: an auth failure
// must never delete the token, or the whole machine signs out of both agents.
for (const status of [401, 402, 403]) {
  test(`transferEventLog keeps the license and the batch on HTTP ${status}`, async () => {
    const token = makeJwt({ exp: FUTURE });
    credstore.setLicenseToken(token);

    const seen = [];
    const srv = await startServer((req, res) => {
      seen.push(req.headers["authorization"] || null);
      res.writeHead(status);
      res.end("nope");
    });
    const logFile = tmpLogFile('{"a":1}\n');

    try {
      const outcome = await logger.transferEventLog(
        logFile,
        `${srv.url}/logs/codex`,
        5000
      );
      assert.equal(outcome, "auth");
      assert.deepEqual(seen, [`Bearer ${token}`], "no anonymous retry");
      assert.equal(credstore.getLicenseToken(), token, "license survives");
      assert.equal(fs.existsSync(logFile), true, "batch stays queued");
      assert.equal(fs.existsSync(`${logFile}.sent`), false);
    } finally {
      try { fs.unlinkSync(logFile); } catch {}
      await srv.close();
    }
  });
}

test("transferEventLog never sends unauthenticated with an expired JWT", async () => {
  const expired = makeJwt({ exp: PAST });
  credstore.setLicenseToken(expired);

  let sawRequest = false;
  const srv = await startServer((_req, res) => {
    sawRequest = true;
    res.writeHead(200);
    res.end("ok");
  });
  const logFile = tmpLogFile('{"a":1}\n');

  try {
    const outcome = await logger.transferEventLog(
      logFile,
      `${srv.url}/logs/codex`,
      5000
    );
    assert.equal(outcome, "auth");
    assert.equal(sawRequest, false, "the ingest route rejects anonymous posts");
    assert.equal(credstore.getLicenseToken(), expired, "expired license is kept for /refresh");
    assert.equal(fs.existsSync(logFile), true, "batch stays queued");
    assert.equal(fs.existsSync(`${logFile}.sent`), false);
  } finally {
    try { fs.unlinkSync(logFile); } catch {}
    await srv.close();
  }
});

// Routing and authorization come from one credential snapshot, so a concurrent
// sign-in cannot pair tenant A's endpoint with tenant B's JWT.
test("transferEventLog routes by the same token it authenticates with", async () => {
  const token = makeJwt({
    exp: FUTURE,
    aud: "https://tenantb.meter.skillbench.com",
  });
  credstore.setLicenseToken(token);

  const realFetch = global.fetch;
  let seen = null;
  global.fetch = async (url, options) => {
    seen = { url, auth: options.headers["Authorization"] };
    return { ok: true, status: 200 };
  };
  const logFile = tmpLogFile('{"a":1}\n');

  try {
    await logger.transferEventLog(logFile);
    assert.equal(seen.url, "https://tenantb.meter.skillbench.com/logs/codex");
    assert.equal(seen.auth, `Bearer ${token}`);
  } finally {
    global.fetch = realFetch;
    try { fs.unlinkSync(`${logFile}.sent`); } catch {}
  }
});

// A rejected token that still looks fresh must not be resubmitted every sweep.
test("an authenticated rejection forces the next refresh to rotate", async () => {
  const token = makeJwt({ exp: FUTURE });
  credstore.setLicenseToken(token);
  logger.clearLicenseRejected();

  const srv = await startServer((_req, res) => {
    res.writeHead(401);
    res.end("nope");
  });
  const logFile = tmpLogFile('{"a":1}\n');

  try {
    await logger.transferEventLog(logFile, `${srv.url}/logs/codex`, 5000);
    assert.equal(logger.isLicenseRejected(), true, "a refresh is now owed");

    const fresh = makeJwt({ exp: FUTURE, jti: "rotated" });
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
      const rotated = await logger.tryRefreshLicense("TEST-DEVICE");
      assert.equal(refreshCalls, 1, "the rejection defeats the freshness short-circuit");
      assert.equal(rotated, fresh);
      assert.notEqual(rotated, token, "the rejected credential is not reused");
      assert.equal(credstore.getLicenseTokenUncached(), fresh, "rotation is persisted");
    } finally {
      global.fetch = realFetch;
    }
    assert.equal(logger.isLicenseRejected(), false, "marker cleared once rotated");
  } finally {
    try { fs.unlinkSync(logFile); } catch {}
    await srv.close();
  }
});

// A fresh read that finds no token means "no token", never "reuse the cache".
test("getLicenseTokenUncached never resurrects a token another client removed", () => {
  const token = makeJwt({ exp: FUTURE });
  credstore.setLicenseToken(token);
  assert.equal(credstore.getLicenseToken(), token, "cache is warm");

  const credFile = path.join(tmpHome, ".skillbench", "credentials.json");
  const raw = JSON.parse(fs.readFileSync(credFile, "utf8"));
  delete raw.license_jwt;
  fs.writeFileSync(credFile, JSON.stringify(raw) + "\n");

  assert.equal(credstore.getLicenseToken(), token, "the cached read still sees it");
  assert.equal(credstore.getLicenseTokenUncached(), null, "the fresh read does not");
});

test("getLicenseTokenUncached returns null while signed out", () => {
  credstore.setLicenseToken(makeJwt({ exp: FUTURE }));
  assert.notEqual(credstore.getLicenseTokenUncached(), null);

  const credFile = path.join(tmpHome, ".skillbench", "credentials.json");
  const raw = JSON.parse(fs.readFileSync(credFile, "utf8"));
  raw.signed_out = true;
  fs.writeFileSync(credFile, JSON.stringify(raw) + "\n");

  try {
    assert.equal(credstore.getLicenseTokenUncached(), null);
  } finally {
    credstore.markEngaged();
  }
});

test("legacy transcript snapshots remain queued without an unsequenced upload", async () => {
  const token = makeJwt({ exp: FUTURE });
  credstore.setLicenseToken(token);
  const pending = tmpLogFile('{"type":"message"}\n');
  const realFetch = global.fetch;
  global.fetch = async () => assert.fail("legacy snapshot must not be uploaded");
  try {
    const outcome = await logger.uploadPendingTranscript(pending, "TEST-DEVICE");
    assert.equal(outcome, "skip");
    assert.equal(credstore.getLicenseToken(), token, "license survives");
    assert.equal(fs.existsSync(pending), true, "snapshot stays pending");
  } finally {
    global.fetch = realFetch;
    fs.unlinkSync(pending);
  }
});

test("prepareSession refreshes an expired token so the current session is authenticated", async () => {
  const sessionStart = require("../../scripts/session_start");
  const expired = makeJwt({ exp: PAST });
  const fresh = makeJwt({ exp: FUTURE });
  credstore.setLicenseToken(expired);
  assert.equal(credstore.isLicenseTokenExpired(expired), true);

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

  let sawAuth = null;
  const srv = await startServer((req, res) => {
    sawAuth = req.headers["authorization"] || null;
    res.writeHead(200);
    res.end("ok");
  });
  const logFile = tmpLogFile('{"event":"SessionStart"}\n');
  try {
    await logger.transferEventLog(logFile, `${srv.url}/logs/codex`, 5000);
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
  const sessionStart = require("../../scripts/session_start");
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

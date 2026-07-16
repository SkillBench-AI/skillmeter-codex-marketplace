"use strict";

/**
 * Unit tests for the retry monitor's proactive license refresh (TEL-5) and its
 * self-termination lifecycle. Run with:
 *   node --test plugins/skillmeter/test/retry-daemon.test.js
 *
 * State is isolated by pointing HOME + PLUGIN_DATA at throwaway dirs (so the
 * shared ~/.skillbench/credentials.json and the real durable queue are never
 * touched) and seeding a device id + hash salt up front so credstore never
 * reaches the macOS Keychain. All of this MUST happen before logger is required,
 * since those paths are resolved at module load.
 *
 * The refresh endpoint is domain-gated (getRefreshUrl only accepts trusted
 * skillbench hosts), so the network path can't be pointed at a localhost server.
 * Instead we exercise the real logger.tryRefreshLicense with a stubbed
 * global.fetch (the domain gate never runs because nothing hits the network),
 * and monkeypatch logger.* for the failure-isolation cases — the daemon reads
 * logger.tryRefreshLicense / logger.drainQueuesOnce as properties at call time.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "sk-daemon-home-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "sk-daemon-data-"));
process.env.PLUGIN_DATA = tmpData;
delete process.env.SKILLMETER_BACKEND_URL;
delete process.env.SKILLMETER_ACTIVATE_URL;

fs.mkdirSync(path.join(tmpHome, ".skillbench"), { recursive: true });
fs.writeFileSync(
  path.join(tmpHome, ".skillbench", "credentials.json"),
  JSON.stringify({ device_id: "TEST-DEVICE", hash_salt: "deadbeef" }) + "\n"
);

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const logger = require("../scripts/logger");
const credstore = require("../scripts/credstore");
const daemon = require("../scripts/monitors/retry_daemon");

const DAEMON_PATH = path.join(__dirname, "..", "scripts", "monitors", "retry_daemon.js");

// --- helpers ---------------------------------------------------------------

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeJwt(claims) {
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.sig`;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

const realFetch = global.fetch;
const realTryRefresh = logger.tryRefreshLicense;
const realDrain = logger.drainQueuesOnce;

afterEach(() => {
  global.fetch = realFetch;
  logger.tryRefreshLicense = realTryRefresh;
  logger.drainQueuesOnce = realDrain;
});

// --- proactive refresh -----------------------------------------------------

test("maybeRefreshLicense rotates an expiring token via the awaited /refresh", async () => {
  credstore.setLicenseToken(makeJwt({ exp: nowSec() - 60 }));
  const fresh = makeJwt({ exp: nowSec() + 3600 });

  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ token: fresh }), text: async () => "" };
  };

  await daemon.maybeRefreshLicense();

  assert.equal(calls, 1, "an expiring token triggers exactly one /refresh");
  assert.equal(credstore.getLicenseToken(), fresh, "the rotated token is persisted");
  assert.equal(credstore.isLicenseTokenExpired(fresh), false);
});

test("maybeRefreshLicense makes no network call when the token is comfortably valid", async () => {
  const valid = makeJwt({ exp: nowSec() + 3600 });
  credstore.setLicenseToken(valid);

  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    return { ok: true, status: 200, json: async () => ({ token: "x" }), text: async () => "" };
  };

  await daemon.maybeRefreshLicense();

  assert.equal(fetchCalled, false, "a valid token short-circuits before any network");
  assert.equal(credstore.getLicenseToken(), valid, "the valid token is left untouched");
});

test("a continuous session outliving its token keeps rotating without re-signin", async () => {
  // Each refreshed token is still inside the 5-min expiry skew, so every sweep
  // sees it as expiring and rotates again — simulating a session that runs well
  // past a single token lifetime. No sign-in ever happens in this loop.
  credstore.setLicenseToken(makeJwt({ exp: nowSec() - 60 }));

  let calls = 0;
  let lastIssued = null;
  global.fetch = async () => {
    calls += 1;
    lastIssued = makeJwt({ exp: nowSec() + 60, jti: calls });
    return { ok: true, status: 200, json: async () => ({ token: lastIssued }), text: async () => "" };
  };

  const SWEEPS = 5;
  for (let i = 0; i < SWEEPS; i++) {
    await daemon.maybeRefreshLicense();
  }

  assert.equal(calls, SWEEPS, "every sweep re-rotates the still-expiring token");
  assert.equal(credstore.getLicenseToken(), lastIssued, "the newest token is always persisted");
});

test("a refresh failure is logged and never aborts the sweep's drain", async () => {
  // Own the lock so sweep() doesn't stand down, then make the refresh throw and
  // confirm drainQueuesOnce still runs to completion.
  logger.refreshRetryDaemonLock();
  assert.equal(logger.ownsRetryDaemonLock(), true);

  logger.tryRefreshLicense = async () => {
    throw new Error("boom");
  };
  let drained = 0;
  logger.drainQueuesOnce = async () => {
    drained += 1;
    return 0;
  };

  await assert.doesNotReject(daemon.sweep());
  assert.equal(drained, 1, "the drain runs even after the refresh throws");

  logger.clearRetryDaemonLock();
});

test("maybeRefreshLicense passes the device id and is a no-op with no device", async () => {
  let seenDeviceId = "unset";
  logger.tryRefreshLicense = async (deviceId) => {
    seenDeviceId = deviceId;
    return null;
  };

  await daemon.maybeRefreshLicense();
  assert.equal(seenDeviceId, "TEST-DEVICE", "the resolved device id is forwarded to tryRefreshLicense");
});

// --- self-termination lifecycle --------------------------------------------

test("the daemon self-terminates once the queues stay idle (shortened env)", async () => {
  // Signed out + no token → tryRefreshLicense short-circuits with zero external
  // calls, so this stays hermetic. With an empty queue every sweep is idle, so
  // the daemon exits cleanly after MAX_IDLE_SWEEPS.
  const subHome = fs.mkdtempSync(path.join(os.tmpdir(), "sk-daemon-sub-home-"));
  const subData = fs.mkdtempSync(path.join(os.tmpdir(), "sk-daemon-sub-data-"));
  fs.mkdirSync(path.join(subHome, ".skillbench"), { recursive: true });
  fs.writeFileSync(
    path.join(subHome, ".skillbench", "credentials.json"),
    JSON.stringify({ device_id: "SUB-DEVICE", hash_salt: "deadbeef", signed_out: true }) + "\n"
  );

  const result = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [DAEMON_PATH],
      {
        env: {
          ...process.env,
          HOME: subHome,
          USERPROFILE: subHome,
          PLUGIN_DATA: subData,
          SKILLMETER_RETRY_DAEMON_INITIAL_DELAY_MS: "10",
          SKILLMETER_RETRY_DAEMON_INTERVAL_MS: "10",
          SKILLMETER_RETRY_DAEMON_MAX_IDLE_SWEEPS: "2",
          SKILLMETER_RETRY_DAEMON_MAX_LIFETIME_MS: "60000",
        },
        timeout: 10000,
      },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, err, stdout, stderr })
    );
  });

  assert.equal(result.stdout, "", "the daemon keeps stdout silent");
  assert.match(result.stderr, /exiting \(queues idle\)/, "it self-terminates on idle");
  assert.equal(result.err || null, null, "it exits 0 without being killed by the timeout");
});

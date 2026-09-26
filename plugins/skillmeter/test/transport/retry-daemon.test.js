"use strict";
// The retry monitor: proactive license refresh inside a sweep, failure
// isolation, and self-termination of the real daemon once queues stay idle.
const { isolateHome, tempDir, writeCredentials, makeJwt, SCRIPTS } = require("../../test-support/plugin.cjs");
isolateHome({ device_id: "TEST-DEVICE", hash_salt: "deadbeef" });
process.env.PLUGIN_DATA = tempDir("sk-daemon-data");
delete process.env.SKILLMETER_BACKEND_URL;
delete process.env.SKILLMETER_ACTIVATE_URL;

const path = require("node:path");
const { execFile } = require("node:child_process");
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const logger = require("../../scripts/logger");
const credstore = require("../../scripts/credstore");
const daemon = require("../../scripts/monitors/retry_daemon");

const DAEMON_PATH = path.join(SCRIPTS, "monitors", "retry_daemon.js");

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

test("a refresh failure is logged and never aborts the sweep's drain", async () => {
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

test("maybeRefreshLicense forwards the resolved device id to tryRefreshLicense", async () => {
  let seenDeviceId = "unset";
  logger.tryRefreshLicense = async (deviceId) => {
    seenDeviceId = deviceId;
    return null;
  };

  await daemon.maybeRefreshLicense();
  assert.equal(seenDeviceId, "TEST-DEVICE", "the resolved device id is forwarded to tryRefreshLicense");
});

test("the daemon self-terminates once the queues stay idle (shortened env)", async () => {
  // Signed out with an empty queue: no external call, every sweep idle.
  const subHome = tempDir("sk-daemon-sub-home");
  const subData = tempDir("sk-daemon-sub-data");
  writeCredentials(subHome, { device_id: "SUB-DEVICE", hash_salt: "deadbeef", signed_out: true });

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

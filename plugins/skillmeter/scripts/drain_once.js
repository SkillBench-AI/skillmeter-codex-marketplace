#!/usr/bin/env node
/**
 * Drain durable queues in a detached process so hooks do not wait on uploads.
 * Failed uploads remain on disk for a later drain or retry-monitor sweep.
 */

const {
  drainQueuesOnce,
  clearDrainOnceLock,
  getDeviceId,
  tryRefreshLicense,
} = require("./logger.js");

async function main() {
  try {
    // Refresh before draining: the session may have outlived its token.
    // Refresh failure leaves uploads queued.
    try {
      const deviceId = getDeviceId();
      if (deviceId) await tryRefreshLicense(deviceId);
    } catch {}
    await drainQueuesOnce();
  } finally {
    clearDrainOnceLock();
  }
}

main().catch((err) => {
  process.stderr.write(
    `[skillmeter-drain-once] ${err && err.message ? err.message : err}\n`
  );
  clearDrainOnceLock();
  process.exit(1);
});

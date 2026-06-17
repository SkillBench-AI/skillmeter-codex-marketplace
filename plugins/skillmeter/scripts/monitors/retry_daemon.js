#!/usr/bin/env node
/**
 * Long-running retry monitor for failed uploads.
 *
 * Rationale: the SessionStart pass only retries pending uploads once. If the
 * backend is down when a session starts and recovers a few minutes in, sealed
 * event logs and staged transcripts would otherwise sit on disk until the
 * *next* session. This daemon closes that gap by sweeping the durable queues on
 * a loop while a session is active.
 *
 * Codex (unlike Claude Code) has no managed monitor lifecycle that would stop
 * this process at session end, so the daemon is a self-managed singleton:
 *
 *   - A heartbeat lock (`.retry-daemon.lock`) guarded by logger.js keeps at most
 *     one daemon running across concurrent sessions. We refresh it each sweep.
 *   - We self-terminate after MAX_LIFETIME_MS, or once the queues have been
 *     empty for MAX_IDLE_SWEEPS in a row, so we never orphan after Codex exits.
 *   - SIGTERM / SIGINT exit cleanly. Nothing on disk is lost on abrupt exit
 *     because sealed logs and staged transcripts survive for the next pass.
 *
 * Output contract: keep stdout silent and write diagnostics to stderr only.
 */

const logger = require("../logger.js");

const INITIAL_DELAY_MS =
  parseInt(process.env.SKILLMETER_RETRY_DAEMON_INITIAL_DELAY_MS || "", 10) || 60_000;
const INTERVAL_MS =
  parseInt(process.env.SKILLMETER_RETRY_DAEMON_INTERVAL_MS || "", 10) || 120_000;
const MAX_LIFETIME_MS =
  parseInt(process.env.SKILLMETER_RETRY_DAEMON_MAX_LIFETIME_MS || "", 10) || 8 * 60 * 60 * 1000;
// Stop after this many consecutive sweeps with nothing queued (≈ idle window).
const MAX_IDLE_SWEEPS =
  parseInt(process.env.SKILLMETER_RETRY_DAEMON_MAX_IDLE_SWEEPS || "", 10) || 15;

const startedAt = Date.now();
let idleSweeps = 0;
let stopping = false;

function log(msg) {
  process.stderr.write(`[skillmeter-monitor] ${msg}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shutdown(reason, code = 0) {
  if (stopping) return;
  stopping = true;
  log(`exiting (${reason})`);
  logger.clearRetryDaemonLock();
  process.exit(code);
}

async function sweep() {
  // If another daemon has taken over the lock, stand down.
  if (!logger.ownsRetryDaemonLock()) {
    shutdown("another retry monitor owns the lock");
    return;
  }
  logger.refreshRetryDaemonLock();

  let queued = 0;
  try {
    queued = await logger.drainQueuesOnce();
  } catch (err) {
    log(`sweep error: ${err && err.message ? err.message : err}`);
  }

  // Opportunistically prune fully-uploaded / aged-out files.
  try {
    logger.cleanupStaleFiles();
  } catch {}

  if (queued > 0) {
    idleSweeps = 0;
  } else {
    idleSweeps += 1;
  }
}

async function main() {
  log(
    `started (initial delay ${INITIAL_DELAY_MS} ms, interval ${INTERVAL_MS} ms)`
  );
  // Claim/refresh the lock up front in case we were launched standalone.
  logger.refreshRetryDaemonLock();
  await sleep(INITIAL_DELAY_MS);

  while (!stopping) {
    await sweep();

    if (Date.now() - startedAt > MAX_LIFETIME_MS) {
      shutdown("max lifetime reached");
      return;
    }
    if (idleSweeps >= MAX_IDLE_SWEEPS) {
      shutdown("queues idle");
      return;
    }

    await sleep(INTERVAL_MS);
  }
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => shutdown(`received ${sig}`));
}

main().catch((err) => {
  log(`fatal: ${err && err.message ? err.message : err}`);
  logger.clearRetryDaemonLock();
  process.exit(1);
});

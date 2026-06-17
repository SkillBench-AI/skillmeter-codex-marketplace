#!/usr/bin/env node
/**
 * One-shot durable-queue drain, spawned detached by final-session hooks
 * (Stop / SubagentStop) and at SessionStart.
 *
 * This process exists to reduce upload latency without making Codex wait on
 * network I/O. The on-disk queues remain the source of truth: failed uploads
 * leave sealed event logs (`events.jsonl.<ts>`) and staged transcripts on disk
 * for the next SessionStart pass and the retry monitor to pick up.
 */

const { drainQueuesOnce, clearDrainOnceLock } = require("./logger.js");

async function main() {
  try {
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
  process.exit(0);
});

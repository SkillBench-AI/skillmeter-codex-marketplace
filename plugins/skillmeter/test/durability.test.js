"use strict";

/**
 * Unit tests for upload durability: poison-batch handling, partial-rejection
 * salvage, max-retry / max-age give-up, atomic writes, and cleanup (SBEE-154).
 * Run with:  node --test plugins/skillmeter/test/durability.test.js
 *
 * Like the other suites, state is isolated by pointing HOME at a throwaway dir
 * (so ~/.skillbench/credentials.json is never touched) and seeding a device id
 * + hash salt up front so credstore never reaches the macOS Keychain. We also
 * point PLUGIN_DATA at a temp dir so the durable queue lives under tmp, and cap
 * the retry budget low so the max-retry path is cheap to exercise. All of this
 * MUST happen before logger is required, since those paths/limits are resolved
 * at module load.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "sk-dur-home-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.SKILLMETER_BACKEND_URL;

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "sk-dur-data-"));
process.env.PLUGIN_DATA = tmpData;
process.env.SKILLMETER_MAX_BATCH_RETRIES = "3";

fs.mkdirSync(path.join(tmpHome, ".skillbench"), { recursive: true });
fs.writeFileSync(
  path.join(tmpHome, ".skillbench", "credentials.json"),
  JSON.stringify({ device_id: "TEST-DEVICE", hash_salt: "deadbeef" }) + "\n"
);

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const logger = require("../scripts/logger");

const BACKEND = "https://acme.meter.skillbench.com/logs/codex";

// --- helpers ---------------------------------------------------------------

const realFetch = global.fetch;

// Replace global.fetch with a scripted sequence of {ok,status} responses. The
// last entry is reused once the sequence is exhausted so a retry loop has a
// stable terminal state. Returns a calls counter.
function stubFetch(sequence) {
  const calls = { count: 0 };
  global.fetch = async () => {
    const i = Math.min(calls.count, sequence.length - 1);
    calls.count += 1;
    const { status } = sequence[i];
    return { ok: status >= 200 && status < 300, status };
  };
  return calls;
}

function freshDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

// Seal a batch with a *recent* timestamp so the max-age give-up doesn't fire;
// a counter keeps names unique within a run.
let seq = 0;
function sealedBatch(contents) {
  const p = path.join(logger.LOG_DIR, `events.jsonl.${Date.now() + seq++}`);
  fs.writeFileSync(p, contents);
  return p;
}

const VALID = '{"a":1}\n{"b":2}\n';

beforeEach(() => {
  freshDir(logger.LOG_DIR);
  fs.rmSync(logger.POISON_DIR, { recursive: true, force: true });
});

afterEach(() => {
  global.fetch = realFetch;
});

// --- HTTP classification ---------------------------------------------------

test("isPermanentHttpStatus: 4xx permanent except 408/429; 5xx transient", () => {
  assert.equal(logger.isPermanentHttpStatus(400), true);
  assert.equal(logger.isPermanentHttpStatus(413), true);
  assert.equal(logger.isPermanentHttpStatus(422), true);
  assert.equal(logger.isPermanentHttpStatus(408), false);
  assert.equal(logger.isPermanentHttpStatus(429), false);
  assert.equal(logger.isPermanentHttpStatus(500), false);
  assert.equal(logger.isPermanentHttpStatus(503), false);
});

// --- atomic writes ---------------------------------------------------------

test("atomicAppendLine writes one newline-terminated record per call", () => {
  const f = path.join(logger.LOG_DIR, "active.jsonl");
  logger.atomicAppendLine(f, '{"x":1}');
  logger.atomicAppendLine(f, '{"y":2}\n'); // already terminated — not doubled
  const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  assert.deepEqual(lines, ['{"x":1}', '{"y":2}']);
  for (const l of lines) JSON.parse(l); // every line is parseable
});

test("atomicWriteFileSync replaces content and leaves no temp file behind", () => {
  const f = path.join(logger.LOG_DIR, "atomic.txt");
  logger.atomicWriteFileSync(f, "hello");
  assert.equal(fs.readFileSync(f, "utf8"), "hello");
  const leftovers = fs.readdirSync(logger.LOG_DIR).filter((n) => n.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

// --- partial-rejection salvage --------------------------------------------

test("salvageBatch drops only invalid lines and rewrites atomically", () => {
  const p = sealedBatch('{"a":1}\nNOT JSON\n{"b":2}\n');
  const res = logger.salvageBatch(p);
  assert.equal(res.rewrote, true);
  assert.equal(res.kept, 2);
  assert.equal(res.dropped, 1);
  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test("salvageBatch does not rewrite when every line is valid", () => {
  const p = sealedBatch(VALID);
  const res = logger.salvageBatch(p);
  assert.equal(res.rewrote, false);
  assert.equal(res.dropped, 0);
});

test("salvageBatch reports nothing salvageable when all lines are invalid", () => {
  const p = sealedBatch("garbage\nmore garbage\n");
  const res = logger.salvageBatch(p);
  assert.equal(res.rewrote, false);
  assert.equal(res.kept, 0);
  assert.ok(res.dropped >= 2);
});

// --- processSealedBatch: the queue-aware wrapper ---------------------------

test("processSealedBatch marks a batch .sent on 2xx and clears its meta", async () => {
  const p = sealedBatch(VALID);
  logger.writeBatchMeta(p, { attempts: 2 });
  stubFetch([{ status: 200 }]);

  const outcome = await logger.processSealedBatch(p, BACKEND, 1000);
  assert.equal(outcome, "sent");
  assert.equal(fs.existsSync(`${p}.sent`), true);
  assert.equal(fs.existsSync(p), false);
  assert.equal(fs.existsSync(logger.batchMetaPath(p)), false);
});

test("processSealedBatch salvages a partially-poisoned batch then succeeds", async () => {
  const p = sealedBatch('{"a":1}\nBROKEN\n{"b":2}\n');
  // First POST is rejected as a permanent error; after salvage drops the bad
  // line the retried POST succeeds.
  const calls = stubFetch([{ status: 400 }, { status: 200 }]);

  const outcome = await logger.processSealedBatch(p, BACKEND, 1000);
  assert.equal(outcome, "sent");
  assert.equal(calls.count, 2, "salvage triggers exactly one retry");
  assert.equal(fs.existsSync(`${p}.sent`), true);
  assert.equal(fs.existsSync(path.join(logger.POISON_DIR, path.basename(p))), false);
});

test("processSealedBatch quarantines an all-valid batch the server permanently rejects", async () => {
  const p = sealedBatch(VALID);
  stubFetch([{ status: 400 }]);

  const outcome = await logger.processSealedBatch(p, BACKEND, 1000);
  assert.equal(outcome, "poison");
  assert.equal(fs.existsSync(p), false, "original removed from the live queue");
  assert.equal(
    fs.existsSync(path.join(logger.POISON_DIR, path.basename(p))),
    true,
    "moved into the poison dir, not deleted"
  );
});

test("processSealedBatch retries transient failures and quarantines at the retry cap", async () => {
  const p = sealedBatch(VALID);
  stubFetch([{ status: 503 }]); // always transient

  // MAX_BATCH_RETRIES is 3 (set via env above): two retries are kept, the
  // third attempt trips the cap and quarantines.
  let outcome = await logger.processSealedBatch(p, BACKEND, 1000);
  assert.equal(outcome, "retry");
  assert.equal(logger.readBatchMeta(p).attempts, 1);

  outcome = await logger.processSealedBatch(p, BACKEND, 1000);
  assert.equal(outcome, "retry");
  assert.equal(logger.readBatchMeta(p).attempts, 2);

  outcome = await logger.processSealedBatch(p, BACKEND, 1000);
  assert.equal(outcome, "poison");
  assert.equal(fs.existsSync(p), false);
  assert.equal(fs.existsSync(path.join(logger.POISON_DIR, path.basename(p))), true);
  assert.equal(fs.existsSync(logger.batchMetaPath(p)), false, "meta sidecar removed on quarantine");
});

test("processSealedBatch quarantines a batch older than the max age without uploading", async () => {
  // Seal timestamp far in the past (well beyond BATCH_MAX_AGE_MS).
  const oldTs = Date.now() - (logger.BATCH_MAX_AGE_MS + 60_000);
  const p = path.join(logger.LOG_DIR, `events.jsonl.${oldTs}`);
  fs.writeFileSync(p, VALID);
  const calls = stubFetch([{ status: 200 }]);

  const outcome = await logger.processSealedBatch(p, BACKEND, 1000);
  assert.equal(outcome, "poison");
  assert.equal(calls.count, 0, "an aged-out batch is never uploaded");
  assert.equal(fs.existsSync(path.join(logger.POISON_DIR, path.basename(p))), true);
});

// --- cleanup ----------------------------------------------------------------

test("cleanupStaleFiles prunes old .sent logs, old poison files, and orphan meta", () => {
  const old = Date.now() / 1000 - (40 * 24 * 60 * 60); // 40 days ago (seconds)

  const sent = path.join(logger.LOG_DIR, "events.jsonl.1700000000020.sent");
  fs.writeFileSync(sent, VALID);
  fs.utimesSync(sent, old, old);

  fs.mkdirSync(logger.POISON_DIR, { recursive: true });
  const poison = path.join(logger.POISON_DIR, "events.jsonl.1700000000021");
  fs.writeFileSync(poison, VALID);
  fs.utimesSync(poison, old, old);

  // Orphan meta sidecar whose batch no longer exists.
  const orphanMeta = path.join(logger.LOG_DIR, "events.jsonl.1700000000022.meta");
  fs.writeFileSync(orphanMeta, '{"attempts":1}\n');
  fs.utimesSync(orphanMeta, old, old);

  // A fresh sent log must survive.
  const freshSent = path.join(logger.LOG_DIR, "events.jsonl.1700000000023.sent");
  fs.writeFileSync(freshSent, VALID);

  logger.cleanupStaleFiles();

  assert.equal(fs.existsSync(sent), false, "old .sent pruned");
  assert.equal(fs.existsSync(poison), false, "old poison pruned");
  assert.equal(fs.existsSync(orphanMeta), false, "orphan meta pruned");
  assert.equal(fs.existsSync(freshSent), true, "fresh .sent retained");
});

// --- transcript staging atomicity ------------------------------------------

test("stageTranscriptForUpload writes atomically with no temp leftovers", () => {
  const src = path.join(tmpData, "rollout-1.jsonl");
  fs.writeFileSync(src, '{"type":"message"}\n');

  const pending = logger.stageTranscriptForUpload(src);
  assert.ok(pending, "staging returns a pending path");
  assert.equal(fs.existsSync(pending), true);
  const leftovers = fs
    .readdirSync(logger.TRANSCRIPTS_PENDING_DIR)
    .filter((n) => n.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "no atomic-write temp files left behind");
});

test("collectTranscriptPaths includes both subagent and session transcripts", () => {
  const sessionTranscript = path.join(tmpData, "session.jsonl");
  const agentTranscript = path.join(tmpData, "agent.jsonl");
  fs.writeFileSync(sessionTranscript, '{"type":"session"}\n');
  fs.writeFileSync(agentTranscript, '{"type":"agent"}\n');

  const paths = logger.collectTranscriptPaths({
    transcript_path: sessionTranscript,
    agent_transcript_path: agentTranscript,
  });

  assert.deepEqual(paths, [
    path.resolve(agentTranscript),
    path.resolve(sessionTranscript),
  ]);
});

test("collectTranscriptPaths falls back to Codex session store by session id", () => {
  const sessionId = "019edc5e-ac83-72f0-bdff-1f819107926a";
  const sessionsDir = path.join(tmpData, "codex-home", "sessions");
  const datedDir = path.join(sessionsDir, "2026", "06", "18");
  fs.mkdirSync(datedDir, { recursive: true });
  const transcript = path.join(
    datedDir,
    `rollout-2026-06-18T15-14-12-${sessionId}.jsonl`
  );
  fs.writeFileSync(transcript, '{"type":"session_meta"}\n');

  const paths = logger.collectTranscriptPaths(
    {
      session_id: sessionId,
      transcript_path: null,
      agent_transcript_path: null,
    },
    { sessionsDir }
  );

  assert.deepEqual(paths, [path.resolve(transcript)]);
});

test("collectTranscriptPaths fallback can match session_meta payload id", () => {
  const sessionId = "019edc5e-ac83-72f0-bdff-1f819107926a";
  const sessionsDir = path.join(tmpData, "codex-home-meta", "sessions");
  const datedDir = path.join(sessionsDir, "2026", "06", "18");
  fs.mkdirSync(datedDir, { recursive: true });
  const transcript = path.join(datedDir, "rollout-without-id.jsonl");
  fs.writeFileSync(
    transcript,
    JSON.stringify({
      type: "session_meta",
      payload: { id: sessionId },
    }) + "\n"
  );

  const paths = logger.collectTranscriptPaths(
    {
      session_id: sessionId,
      transcript_path: null,
      agent_transcript_path: null,
    },
    { sessionsDir }
  );

  assert.deepEqual(paths, [path.resolve(transcript)]);
});

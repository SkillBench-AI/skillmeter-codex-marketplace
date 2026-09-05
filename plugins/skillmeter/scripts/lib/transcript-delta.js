"use strict";

// Codex-specific durable chunk queue. Reuses Claude's stage/cursor/send model,
// but anchors on raw complete-byte position and prefix HMAC, not optional UUIDs.
// All files are private to PLUGIN_DATA; this module never accesses credentials.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { sanitizeLine } = require("../sanitizer");

const MAX_ENVELOPE = 5 * 1024 * 1024; // below the 6 MiB Lambda event ceiling
const ENVELOPE_RESERVE = 128 * 1024; // headers + JSON event wrapper
const MAX_RECORD = 32 * 1024 * 1024;
const STAGE_BYTES = 8 * 1024 * 1024;
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const hmac = (salt, bytes) => crypto.createHmac("sha256", salt).update(bytes).digest("hex");

function syncDir(dir) {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeDurable(file, bytes) {
  const tmp = `${file}.tmp-${crypto.randomUUID()}`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  syncDir(path.dirname(file));
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true; // incomplete lock: fail closed
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
}

// Exclusive PID lock, no expiry-based takeover of live writers. Dead-owner
// reaping is serialized for the observed inode, preventing two stale reapers
// from unlinking a newly acquired lock. A crash during reaping is recoverable.
function acquireLock(file, depth = 0) {
  if (depth > 8) return null;
  const ownerFile = `${file}.owner-${crypto.randomUUID()}`;
  const fd = fs.openSync(ownerFile, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const inode = fs.statSync(ownerFile).ino;
  try { fs.linkSync(ownerFile, file); fs.unlinkSync(ownerFile); }
  catch (e) {
    fs.unlinkSync(ownerFile);
    if (e.code !== "EEXIST") throw e;
    const st = fs.statSync(file);
    let owner;
    try { owner = readJson(file); } catch { return null; }
    if (alive(owner.pid)) return null;
    const releaseReaper = acquireLock(`${file}.reap-${st.ino}`, depth + 1);
    if (!releaseReaper) return null;
    try {
      try { if (fs.statSync(file).ino === st.ino) fs.unlinkSync(file); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    } finally { releaseReaper(); }
    return acquireLock(file, depth + 1);
  }
  return () => {
    try { if (fs.statSync(file).ino === inode) fs.unlinkSync(file); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  };
}

function prefix(fd, length, salt) {
  const hash = crypto.createHmac("sha256", salt);
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  while (position < length) {
    const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, length - position), position);
    if (!n) throw new Error("source-truncated-during-read");
    hash.update(buffer.subarray(0, n)); position += n;
  }
  return hash;
}

function encodeChunks(lines, maxEnvelope = MAX_ENVELOPE) {
  const limit = Math.min(MAX_ENVELOPE, maxEnvelope);
  if (!Number.isFinite(limit) || limit <= ENVELOPE_RESERVE + 128) throw new Error("invalid-wire-budget");
  const output = [];
  function encode(group) {
    const body = zlib.gzipSync(Buffer.from(group.join("")));
    if (4 * Math.ceil(body.length / 3) + ENVELOPE_RESERVE <= limit) {
      output.push({ body, records: group.length }); return;
    }
    if (group.length === 1) throw new Error("oversized-single-record");
    const mid = Math.floor(group.length / 2);
    encode(group.slice(0, mid)); encode(group.slice(mid));
  }
  if (lines.length) encode(lines);
  return output;
}

function groups(dir) {
  return fs.readdirSync(dir).filter(n => /^batch-\d+-[a-f0-9-]+$/.test(n)).sort().map(n => path.join(dir, n));
}
function recover(dir) {
  const file = path.join(dir, "cursor.json");
  let cursor = fs.existsSync(file) ? readJson(file) : null;
  if (cursor && (cursor.version !== 1 || !Number.isSafeInteger(cursor.seq) || cursor.seq < 1)) {
    throw new Error("invalid-cursor");
  }
  for (const group of groups(dir)) {
    const commit = readJson(path.join(group, "commit.json"));
    if (!cursor || commit.cursor.seq > cursor.seq) {
      for (const chunk of commit.chunks) {
        if (digest(fs.readFileSync(path.join(group, chunk.file))) !== chunk.sha256) throw new Error("incomplete-transaction");
      }
      cursor = commit.cursor;
      writeDurable(file, JSON.stringify(cursor));
    }
    if (!fs.existsSync(path.join(group, "ready"))) writeDurable(path.join(group, "ready"), "1");
  }
  return cursor;
}

function stage(root, source, scope, salt, options = {}) {
  const id = hmac(salt, path.resolve(source));
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const release = acquireLock(path.join(dir, "lock"));
  if (!release) return { status: "busy", files: [] };
  let fd;
  try {
    const cursor = recover(dir);
    if (cursor && (cursor.scope.owner !== scope.owner || cursor.scope.deviceId !== scope.deviceId)) {
      throw new Error("source-owner-changed");
    }
    fd = fs.openSync(source, "r");
    const stat = fs.fstatSync(fd);
    const fileId = `${stat.dev}:${stat.ino}`;
    let offset = cursor?.offset || 0;
    let rawPrefix;
    const requested = fs.existsSync(path.join(dir, "reset-request.json")) ? readJson(path.join(dir, "reset-request.json")) : null;
    let reset = !cursor || cursor.fileId !== fileId || stat.size < offset || (requested && requested.baseline >= cursor.baseline);
    if (!reset) {
      rawPrefix = prefix(fd, offset, salt);
      reset = rawPrefix.digest("hex") !== cursor.prefix;
      if (!reset) rawPrefix = prefix(fd, offset, salt);
    }
    if (reset) { offset = 0; rawPrefix = prefix(fd, 0, salt); }
    const generation = reset ? (cursor?.generation || 0) + 1 : cursor.generation;
    const baseline = reset ? (cursor?.seq || 0) + 1 : cursor.baseline;
    let pending = Buffer.alloc(0), readPosition = offset, committed = offset;
    let lineCount = reset ? 0 : cursor.lineCount;
    const lines = [];
    const buffer = Buffer.alloc(64 * 1024);
    // Fixed stage budget, except one supported large record. Partial trailing
    // bytes never enter the cursor and are reconsidered on the next capture.
    while (readPosition < stat.size) {
      const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - readPosition), readPosition);
      if (!n) break;
      readPosition += n;
      pending = Buffer.concat([pending, buffer.subarray(0, n)]);
      let end;
      while ((end = pending.indexOf(10)) >= 0) {
        const raw = pending.subarray(0, end + 1);
        if (raw.length > MAX_RECORD) throw new Error("oversized-single-record");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(raw).trim();
        if (text) {
          let record;
          try { record = JSON.parse(text); } catch { throw new Error("malformed-complete-record"); }
          if (!record || Array.isArray(record) || typeof record !== "object") throw new Error("malformed-complete-record");
          if (options.authorizeRecord && !options.authorizeRecord(record)) throw new Error("source-scope-changed");
          // Collector merges on UUID. Identity uses raw position/content before
          // sanitization, preserving identical authored records and redaction collisions.
          const uuid = hmac(salt, `${id}\0${generation}\0${committed}\0${hmac(salt, raw)}`);
          const sanitized = sanitizeLine(record, salt);
          if (sanitized.uuid) sanitized._codex_source_uuid = sanitized.uuid;
          sanitized.uuid = uuid;
          const serialized = JSON.stringify(sanitized) + "\n";
          if (Buffer.byteLength(serialized) >= MAX_RECORD) throw new Error("oversized-single-record");
          lines.push(serialized);
        }
        rawPrefix.update(raw); committed += raw.length; lineCount++;
        pending = pending.subarray(end + 1);
      }
      if (pending.length > MAX_RECORD) throw new Error("oversized-single-record");
      if (committed - offset >= (options.stageBytes || STAGE_BYTES)) break;
    }
    if (!lines.length) return { status: "unchanged", files: [], partial: pending.length > 0 };
    const encoded = encodeChunks(lines, options.maxEnvelope);
    let seq = cursor?.seq || 0;
    const chunks = encoded.map(({ body, records }) => ({ file: `${++seq}.gz`, seq, reset: baseline, records, sha256: digest(body) }));
    const next = { version: 1, seq, baseline, generation, offset: committed, lineCount,
      prefix: rawPrefix.digest("hex"), fileId, scope, source: path.resolve(source), transcriptId: path.basename(source) };
    // Detect concurrent source rewrite before publishing any state.
    if (prefix(fd, committed, salt).digest("hex") !== next.prefix) throw new Error("source-changed-during-stage");
    const group = path.join(dir, `batch-${String(chunks[0].seq).padStart(16, "0")}-${crypto.randomUUID()}`);
    const temp = path.join(dir, `.stage-${crypto.randomUUID()}`);
    fs.mkdirSync(temp, { mode: 0o700 });
    for (let i = 0; i < chunks.length; i++) writeDurable(path.join(temp, chunks[i].file), encoded[i].body);
    writeDurable(path.join(temp, "commit.json"), JSON.stringify({ cursor: next, chunks }));
    options.fault?.("before-publish");
    fs.renameSync(temp, group); syncDir(dir);
    options.fault?.("after-publish");
    writeDurable(path.join(dir, "cursor.json"), JSON.stringify(next));
    options.fault?.("after-cursor");
    writeDurable(path.join(group, "ready"), "1");
    return { status: "staged", files: chunks.map(c => path.join(group, c.file)), cursor: next };
  } catch (e) {
    // Error code only. Never persist source text or arbitrary exception payloads.
    const code = ["oversized-single-record", "malformed-complete-record", "invalid-wire-budget",
      "source-changed-during-stage", "source-truncated-during-read", "invalid-cursor", "incomplete-transaction", "source-scope-changed", "source-owner-changed"].includes(e.message) ? e.message : "stage-failed";
    writeDurable(path.join(dir, "diagnostic.json"), JSON.stringify({ code, at: new Date().toISOString() }));
    throw e;
  } finally { if (fd !== undefined) fs.closeSync(fd); release(); }
}

function queueDirectories(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(n => /^[a-f0-9]{64}$/.test(n)).map(n => path.join(root, n));
}
function pendingFiles(dir) {
  const cursor = fs.existsSync(path.join(dir, "cursor.json")) ? readJson(path.join(dir, "cursor.json")) : null;
  return groups(dir).flatMap(group => {
    // A durable full reset supersedes pending older generations. Keep their
    // immutable files for recovery, but never send them ahead of the reset.
    if (cursor && readJson(path.join(group, "commit.json")).cursor.baseline < cursor.baseline) return [];
    if (!fs.existsSync(path.join(group, "ready"))) return [];
    return readJson(path.join(group, "commit.json")).chunks.map(c => path.join(group, c.file)).filter(f => fs.existsSync(f));
  });
}
function metadata(file) {
  const commit = readJson(path.join(path.dirname(file), "commit.json"));
  const chunk = commit.chunks.find(c => c.file === path.basename(file));
  if (!chunk) throw new Error("unknown-chunk");
  return { ...chunk, scope: commit.cursor.scope, transcriptId: commit.cursor.transcriptId };
}
async function drainDirectory(dir, send) {
  const release = acquireLock(path.join(dir, "lock"));
  if (!release) return 0;
  let sent = 0;
  try {
    recover(dir);
    for (const file of pendingFiles(dir)) {
      const meta = metadata(file), body = fs.readFileSync(file);
      if (digest(body) !== meta.sha256) throw new Error("chunk-integrity-failed");
      const outcome = await send(meta, body);
      if (outcome === "reset-required") {
        writeDurable(path.join(dir, "reset-request.json"), JSON.stringify({ baseline: meta.reset }));
      }
      if (outcome !== "sent") break; // never advance over retry/auth/poison
      fs.unlinkSync(file); syncDir(path.dirname(file)); sent++;
    }
    for (const group of groups(dir)) {
      if (readJson(path.join(group, "commit.json")).chunks.every(c => !fs.existsSync(path.join(group, c.file)))) {
        fs.rmSync(group, { recursive: true }); syncDir(dir);
      }
    }
    return sent;
  } finally { release(); }
}
module.exports = { stage, encodeChunks, acquireLock, recover, queueDirectories, pendingFiles, metadata,
  drainDirectory, writeDurable, hmac, MAX_ENVELOPE, ENVELOPE_RESERVE, MAX_RECORD };

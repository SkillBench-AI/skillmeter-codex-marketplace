"use strict";

// Explicit, local-only migration. A plan is an integrity binding, not consent.
// The caller must supply approved ranges and recheck current authorization.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const json = file => JSON.parse(fs.readFileSync(file, "utf8"));
const fail = code => { throw new Error(code); };

function recoverMigration(dir, io) {
  const receipt = path.join(dir, "legacy-migration.json");
  if (!fs.existsSync(receipt)) return;
  const tx = json(receipt);
  if (tx.version !== 1 || !tx.cursor?.legacyMigration?.receipt || !tx.consent || !tx.beforeDigest ||
      tx.cursor.consentEpoch !== tx.consent.epoch) fail("invalid-legacy-migration");
  const cursorFile = path.join(dir, "cursor.json"), consentFile = path.join(dir, "consent.json");
  const bytes = fs.readFileSync(cursorFile);
  const current = JSON.parse(bytes);
  // Completed migrations must never restore an old cursor or journal after new work.
  if (current.legacyMigration?.receipt === tx.cursor.legacyMigration?.receipt && fs.existsSync(consentFile)) return;
  if (sha(bytes) !== tx.beforeDigest && JSON.stringify(current) !== JSON.stringify(tx.cursor)) fail("legacy-migration-conflict");
  if (fs.existsSync(consentFile) && JSON.stringify(json(consentFile)) !== JSON.stringify(tx.consent)) fail("legacy-migration-conflict");
  io.writeDurable(cursorFile, JSON.stringify(tx.cursor));
  io.writeDurable(consentFile, JSON.stringify(tx.consent));
}

function withQueue(root, source, salt, io, fn) {
  const dir = path.join(root, io.hmac(salt, path.resolve(source)));
  if (!fs.existsSync(path.join(dir, "cursor.json"))) fail("legacy-cursor-required");
  const release = io.acquireLock(path.join(dir, "lock"));
  if (!release) fail("legacy-queue-busy");
  try { io.assertQueueFormats(dir); return fn(dir); } finally { release(); }
}

function snapshot(dir, source, scope, salt, io) {
  io.recover(dir);
  const bytes = fs.readFileSync(path.join(dir, "cursor.json"));
  const cursor = JSON.parse(bytes);
  if (cursor.consentEpoch || fs.existsSync(path.join(dir, "consent.json"))) fail("legacy-already-migrated");
  if (!scope.owner || !scope.deviceId || !scope.consentStamp || !scope.repoRoot ||
      ["owner", "deviceId", "repoRoot", "org"].some(k => cursor.scope[k] !== scope[k]) ||
      path.resolve(source) !== cursor.source) fail("legacy-scope-mismatch");
  if (io.pendingFiles(dir).length) fail("legacy-pending-chunks");
  if (fs.existsSync(path.join(dir, "reset-request.json"))) fail("legacy-reset-pending");
  const fd = fs.openSync(source, "r");
  try {
    const stat = fs.fstatSync(fd), fileId = `${stat.dev}:${stat.ino}`;
    if (fileId !== cursor.fileId || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 ||
        stat.size < cursor.offset || io.prefix(fd, cursor.offset, salt).digest("hex") !== cursor.prefix) fail("legacy-source-changed");
    for (const offset of [cursor.offset, stat.size]) {
      if (offset) {
        const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, offset - 1);
        if (b[0] !== 10) fail("legacy-incomplete-line");
      }
    }
    return { version: 1, source: path.resolve(source), cursorDigest: sha(bytes),
      fileId, observed: stat.size, sourceDigest: io.prefix(fd, stat.size, salt).digest("hex"),
      scope: { ...scope }, cursor };
  } finally { fs.closeSync(fd); }
}

function prepare(root, source, scope, salt, io) {
  return withQueue(root, source, salt, io, dir => {
    const { cursor, ...plan } = snapshot(dir, source, scope, salt, io);
    return { ...plan, committedOffset: cursor.offset, baseline: cursor.baseline, generation: cursor.generation };
  });
}

function apply(root, source, scope, salt, options, io) {
  return withQueue(root, source, salt, io, dir => {
    const { plan, authorizedRanges, evidence, stamp, authorizeCommit } = options;
    if (!plan || typeof evidence !== "string" || !evidence.trim() || evidence.length > 1024 ||
        typeof stamp !== "string" || !stamp || typeof authorizeCommit !== "function" || authorizeCommit() !== true) fail("legacy-authorization-required");
    recoverMigration(dir, io);
    const receiptFile = path.join(dir, "legacy-migration.json");
    if (fs.existsSync(receiptFile)) {
      const tx = json(receiptFile);
      if (tx.planDigest !== sha(JSON.stringify(plan)) || JSON.stringify(tx.authorizedRanges) !== JSON.stringify(authorizedRanges) ||
          tx.evidence !== evidence) fail("legacy-already-migrated");
      return { status: "already-migrated", receipt: tx.cursor.legacyMigration.receipt };
    }
    const live = snapshot(dir, source, scope, salt, io);
    const { cursor, ...binding } = live;
    const expected = { ...binding, committedOffset: cursor.offset, baseline: cursor.baseline, generation: cursor.generation };
    if (JSON.stringify(plan) !== JSON.stringify(expected)) fail("legacy-stale-plan");
    if (!Array.isArray(authorizedRanges)) fail("legacy-invalid-ranges");
    let position = 0;
    const excluded = [], fd = fs.openSync(source, "r");
    try {
      for (const range of authorizedRanges) {
        if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger) ||
            range[0] < position || range[1] <= range[0] || range[1] > live.observed) fail("legacy-invalid-ranges");
        for (const offset of range) if (offset) {
          const b = Buffer.alloc(1);
          if (fs.readSync(fd, b, 0, 1, offset - 1) !== 1 || b[0] !== 10) fail("legacy-incomplete-line");
        }
        if (range[0] > position) excluded.push([position, range[0]]);
        position = range[1];
      }
      if (position < live.observed) excluded.push([position, live.observed]);
      const stat = fs.fstatSync(fd);
      if (`${stat.dev}:${stat.ino}` !== live.fileId || stat.size !== live.observed ||
          io.prefix(fd, stat.size, salt).digest("hex") !== live.sourceDigest) fail("legacy-source-changed");
    } finally { fs.closeSync(fd); }
    if (authorizeCommit() !== true) fail("legacy-authorization-changed");
    const epoch = crypto.randomUUID(), receipt = crypto.randomUUID();
    const consent = { version: 1, epoch, owner: scope.owner, fileId: live.fileId,
      observed: live.observed, excluded, enabled: true, stamp, authorization: scope.consentStamp,
      source: path.resolve(source), cwd: scope.cwd, repoRoot: scope.repoRoot };
    const migrated = { ...cursor, scope, consentEpoch: epoch, metadataVersion: 1,
      legacyMigration: { receipt, committedOffset: cursor.offset } };
    const tx = { version: 1, beforeDigest: live.cursorDigest, cursor: migrated, consent,
      evidence, authorizedRanges, sourceDigest: live.sourceDigest, planDigest: sha(JSON.stringify(plan)) };
    // This durable receipt commits the bounded approval; recovery finishes both
    // state files under the same queue lock after any interrupted installation.
    io.writeDurable(path.join(dir, "legacy-migration.json"), JSON.stringify(tx));
    options.fault?.("after-receipt");
    io.writeDurable(path.join(dir, "cursor.json"), JSON.stringify(migrated));
    options.fault?.("after-cursor");
    io.writeDurable(path.join(dir, "consent.json"), JSON.stringify(consent));
    return { status: "migrated", receipt, committedOffset: cursor.offset,
      observed: live.observed, baseline: cursor.baseline, generation: cursor.generation, excluded };
  });
}

module.exports = { recoverMigration, prepare, apply };

"use strict";

const fs = require("fs");
const crypto = require("crypto");

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

// A lock still held after this long is broken by definition: the critical
// section is a synchronous read/modify/write of one small JSON file, and
// mutateStore itself gives up waiting after 1s.
const STALE_MS = 60_000;

// Whether the existing owner should be respected.
//
// PID liveness is the primary signal — a writer that is genuinely mid-write
// must never be evicted. But a PID does not identify a process *incarnation*:
// if a writer crashes inside the critical section the OS can later hand that
// number to an unrelated long-lived process, and the lock then looks held for
// as long as that process runs. An owner file we cannot read a pid out of has
// the same effect, since an unknown owner is assumed live. Either way every
// writer — sign-in, sign-out, refresh, the telemetry toggle — would fail with
// `credential-store-busy` indefinitely, with no path back.
//
// Age is therefore the backstop that bounds that failure instead of leaving it
// permanent. It is deliberately three orders of magnitude above the critical
// section, so it can only fire on an owner that is already broken.
function heldByLiveOwner(owner, stat) {
  if (Date.now() - stat.mtimeMs > STALE_MS) return false;
  return alive(owner?.pid);
}

function readOwner(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

// Same owner-file protocol as PR #37's transcript-delta.acquireLock.
// Publish a complete owner atomically; never evict a live writer by age alone.
//
// Ownership is identified by a per-acquisition token carried inside the owner
// file, not by the lock file's inode: an inode is recycled the moment the old
// file is unlinked (readily observable on Linux), so a replacement owner can
// land on the same inode number and make a previous holder believe it is still
// the owner — which would defeat both the release guard and mutateStore's
// pre-write fence.
function acquireLock(file, depth = 0) {
  if (depth > 8) return null;
  const token = crypto.randomUUID();
  const ownerFile = `${file}.owner-${token}`;
  const fd = fs.openSync(ownerFile, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }

  try { fs.linkSync(ownerFile, file); fs.unlinkSync(ownerFile); }
  catch (error) {
    fs.unlinkSync(ownerFile);
    if (error.code !== "EEXIST") throw error;

    let stat;
    try { stat = fs.statSync(file); }
    catch (err) {
      if (err.code === "ENOENT") return acquireLock(file, depth + 1);
      throw err;
    }
    if (heldByLiveOwner(readOwner(file), stat)) return null;

    // Serialize reapers so two of them cannot unlink successive owners.
    const releaseReaper = acquireLock(`${file}.reap`, depth + 1);
    if (!releaseReaper) return null;
    try {
      // Re-judge under the reaper lock rather than acting on the earlier
      // observation: the owner may have been replaced in between, and a
      // replacement is fresh by construction, so it fails the staleness test
      // and survives.
      let stale;
      try { stale = !heldByLiveOwner(readOwner(file), fs.statSync(file)); }
      catch (err) {
        if (err.code !== "ENOENT") throw err;
        stale = false; // already gone; just retry the acquire
      }
      if (stale) {
        try { fs.unlinkSync(file); }
        catch (err) { if (err.code !== "ENOENT") throw err; }
      }
    } finally { releaseReaper(); }

    return acquireLock(file, depth + 1);
  }

  // Whether this handle is still the owner. The age backstop above means a
  // holder can be reaped while it is paused (SIGSTOP, swap, a suspended VM),
  // after which a replacement writer may commit. A holder that is about to
  // persist must therefore re-check ownership rather than assume it, or it
  // would roll the replacement's write back.
  const ownedByUs = () => readOwner(file)?.token === token;

  const release = () => {
    if (!ownedByUs()) return;
    try { fs.unlinkSync(file); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  };
  release.stillHeld = ownedByUs;
  return release;
}

module.exports = { acquireLock };

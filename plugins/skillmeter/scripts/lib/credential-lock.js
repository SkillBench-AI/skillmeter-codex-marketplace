"use strict";

const fs = require("fs");
const crypto = require("crypto");

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

// Same owner-file protocol as PR #37's transcript-delta.acquireLock.
// Publish a complete owner atomically; never evict a live writer by age.
function acquireLock(file, depth = 0) {
  if (depth > 8) return null;
  const ownerFile = `${file}.owner-${crypto.randomUUID()}`;
  const fd = fs.openSync(ownerFile, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  const inode = fs.statSync(ownerFile).ino;
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
    let owner;
    try { owner = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (err) {
      if (err.code === "ENOENT") return acquireLock(file, depth + 1);
      return null;
    }
    if (alive(owner?.pid)) return null;
    const releaseReaper = acquireLock(`${file}.reap-${stat.ino}`, depth + 1);
    if (!releaseReaper) return null;
    try {
      try { if (fs.statSync(file).ino === stat.ino) fs.unlinkSync(file); }
      catch (err) { if (err.code !== "ENOENT") throw err; }
    } finally { releaseReaper(); }
    return acquireLock(file, depth + 1);
  }
  return () => {
    try { if (fs.statSync(file).ino === inode) fs.unlinkSync(file); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  };
}

module.exports = { acquireLock };

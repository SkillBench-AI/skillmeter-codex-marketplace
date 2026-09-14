"use strict";
// Payload removal only. Identity, cursor and consent journals survive so an
// expired/revoked body cannot be reconstructed during a later baseline reset.
const fs = require("node:fs"), path = require("node:path");
const {STATE_DIR} = require("./config");
const chunks = require("./transcript-delta");
const repositories = require("./repository-queue");
const RETENTION_MS = 7 * 86400000;
const data = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || path.join(STATE_DIR,"codex");
const logs = path.join(data,"logs"), request = path.join(logs,"purge-request.json");

function retireDirectory(dir, all = false, now = Date.now()) {
  const release = chunks.acquireLock(path.join(dir,"lock"));
  if (!release) return false;
  try {
    const cursor = chunks.recover(dir);
    const groups = fs.readdirSync(dir).filter(n => /^(batch-|\.stage-)/.test(n));
    let through = 0;
    const remove = [];
    for (const name of groups) {
      const group = path.join(dir,name);
      const commitFile = path.join(group,"commit.json");
      const commit = fs.existsSync(commitFile) ? JSON.parse(fs.readFileSync(commitFile)) : null;
      const expired = all || (commit?.createdAt ?? fs.statSync(group).mtimeMs) < now - RETENTION_MS;
      if (expired) { remove.push(group); through = Math.max(through, commit?.cursor.offset || cursor?.offset || 0); }
    }
    if (all && cursor) {
      through = Math.max(through,cursor.offset);
      try { through = Math.max(through,fs.statSync(cursor.source).size); } catch {}
    }
    const consentFile = path.join(dir,"consent.json");
    const consent = fs.existsSync(consentFile) ? JSON.parse(fs.readFileSync(consentFile)) : null;
    if (all) through = Math.max(through,consent?.observed || 0);
    if (through || all) {
      const file = path.join(dir,"retired.json");
      const old = chunks.readRetirement(dir);
      if (old?.blocked) throw new Error("retired-journal-unavailable");
      const epoch = cursor?.consentEpoch || consent?.epoch;
      const sameEpoch = old?.consentEpoch === epoch;
      chunks.writeDurable(file,JSON.stringify({through:Math.max(through,sameEpoch ? old?.through || 0 : 0),consentEpoch:epoch}));
      if (cursor) chunks.writeDurable(path.join(dir,"reset-request.json"),JSON.stringify({baseline:cursor.baseline}));
    }
    for (const group of remove) fs.rmSync(group,{recursive:true,force:true});
    return true;
  } finally { release(); }
}
function prune(all = false, now = Date.now()) {
  let complete = true;
  // Deprecated unscoped snapshots are never replayed, but still obey logout
  // and age deletion. Only known payload filenames in Codex's own log root.
  for (const [directory, pattern] of [
    [logs,/^events\.jsonl(?:\.\d+)?$/],
    [path.join(logs,"poison"),/^(?:events\.jsonl\.\d+|.*\.(?:jsonl|gz))$/],
    [path.join(logs,"transcripts/pending"),/\.(?:gz|jsonl)$/],
  ]) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory).filter(n => pattern.test(n))) {
      const file = path.join(directory,name), stat = fs.lstatSync(file);
      if (stat.isFile() && (all || stat.mtimeMs < now-RETENTION_MS)) {
        fs.unlinkSync(file); fs.rmSync(file+".meta",{force:true});
      }
    }
  }
  for (const context of repositories.list(path.join(logs,"repositories"))) {
    const result = repositories.withLock(context,() => {
      for (const directory of [context.root,path.join(context.root,"poison")]) {
        if (!fs.existsSync(directory)) continue;
        for (const name of fs.readdirSync(directory)) {
          if (!/^events\.jsonl(?:\.\d+)?$/.test(name)) continue;
          const file = path.join(directory,name), stat = fs.statSync(file);
          if (all) {
            fs.unlinkSync(file); fs.rmSync(file+".meta",{force:true}); continue;
          }
          // An active log can contain both old and recent events. Preserve
          // recent records and their original serialization under the queue lock.
          const raw = fs.readFileSync(file,"utf8");
          const sealedAt = Number(name.match(/\.(\d+)$/)?.[1]) || stat.mtimeMs;
          const kept = raw.split(/(?<=\n)/).filter(line => {
            try { const at = Date.parse(JSON.parse(line).timestamp); return (Number.isFinite(at) ? at : sealedAt) >= now-RETENTION_MS; }
            catch { return sealedAt >= now-RETENTION_MS; }
          }).join("");
          if (kept !== raw) {
            if (kept) chunks.writeDurable(file,kept);
            else { fs.unlinkSync(file); fs.rmSync(file+".meta",{force:true}); }
          }
        }
      }
      return true;
    });
    if (!result) complete = false;
  }
  for (const dir of chunks.queueDirectories(path.join(logs,"transcripts/chunks-v1"))) {
    try { if (!retireDirectory(dir,all,now)) complete = false; }
    catch (error) {
      if (!(error instanceof SyntaxError) && !["invalid-cursor","incomplete-transaction","invalid-retirement-journal","retired-journal-unavailable"].includes(error.message)) throw error;
      // A damaged journal blocks only its own source. If its payload ages out
      // (or logout revokes it), delete the body and persist a fail-closed marker
      // instead of guessing byte offsets that could reconstruct it later.
      const release = chunks.acquireLock(path.join(dir,"lock"));
      if (!release) { complete = false; continue; }
      try {
        for (const name of fs.readdirSync(dir).filter(n => /^(batch-|\.stage-)/.test(n))) {
          const group = path.join(dir,name);
          if (all || fs.statSync(group).mtimeMs < now-RETENTION_MS) {
            chunks.writeDurable(path.join(dir,"retired.json"),JSON.stringify({blocked:true}));
            fs.rmSync(group,{recursive:true,force:true});
          }
        }
        chunks.writeDurable(path.join(dir,"diagnostic.json"),JSON.stringify({code:"queue-unavailable",at:new Date(now).toISOString()}));
      } finally { release(); }
    }
  }
  return complete;
}
function purgeAll() {
  fs.mkdirSync(logs,{recursive:true,mode:0o700});
  chunks.writeDurable(request,JSON.stringify({requestedAt:Date.now()}));
  if (prune(true)) fs.rmSync(request,{force:true});
}
function enforce() {
  const all = fs.existsSync(request);
  const complete = prune(all);
  if (all && complete) fs.rmSync(request,{force:true});
  return complete;
}
// Hooks do not scan old payloads. Background drains/cleanup enforce age; hooks
// only need to honor an unfinished revocation before appending new content.
function enforcePending() { return !fs.existsSync(request) || enforce(); }
module.exports = {purgeAll,enforce,enforcePending,retireDirectory,RETENTION_MS};

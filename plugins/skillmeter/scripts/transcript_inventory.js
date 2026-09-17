#!/usr/bin/env node
"use strict";
// Read-only, content-free recovery inventory. Does not load credstore/logger,
// read transcript bodies, replay queues, or mutate anything.
const fs = require("node:fs"), path = require("node:path");
function countFiles(dir, accept = () => true) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, {withFileTypes: true}).filter(e => e.isFile() && accept(e.name)).length;
}
function inventory(dataDir) {
  const logs = path.join(dataDir, "logs"), chunks = path.join(logs, "transcripts/chunks-v1");
  const reasons = {};
  if (fs.existsSync(chunks)) for (const name of fs.readdirSync(chunks).filter(n => /^[a-f0-9]{64}$/.test(n))) {
    try { const d = JSON.parse(fs.readFileSync(path.join(chunks, name, "diagnostic.json"), "utf8"));
      const code = /^[a-z0-9-]+$/.test(d.code) ? d.code : "unknown";
      reasons[code] = (reasons[code] || 0) + 1;
    } catch {}
  }
  return { dryRun: true, legacyPending: countFiles(path.join(logs, "transcripts/pending"), n => !n.startsWith(".")),
    legacyPoisonUnknownReason: countFiles(path.join(logs, "poison"), n => !n.startsWith("events.jsonl.")),
    chunkDiagnostics: reasons };
}
if (require.main === module) {
  const data = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
  if (!data) { console.error("Set PLUGIN_DATA to the queue to inventory; no default home scan."); process.exitCode = 1; }
  else console.log(JSON.stringify(inventory(data), null, 2));
}
module.exports = { inventory };

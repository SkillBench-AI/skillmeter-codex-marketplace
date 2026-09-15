"use strict";
// Offline only: reads one checked-in synthetic fixture; no logger/auth/network.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const {sanitizeLine} = require("../../plugins/skillmeter/scripts/sanitizer");
const input = fs.readFileSync(path.join(__dirname, "fixture/rollout.jsonl"), "utf8");
const raw = input.trimEnd().split("\n").map(JSON.parse);
const sanitized = raw.map(record => sanitizeLine(record, "synthetic-work-salt"));
const output = sanitized.map(JSON.stringify).join("\n") + "\n";
assert(!output.includes("fixture@example.com"));
assert(!output.includes("SYNTHETIC-NOT-A-CREDENTIAL"));
assert(!output.includes("/synthetic/work-capability"));
assert(output.includes("[EMAIL]"));
assert(output.includes("[REDACTED_SECRET]"));
assert.equal(sanitized[0].payload.id, "work-capability-synthetic-001");
for (const record of sanitized.filter(r => r.payload.type === "function_call")) {
  assert(raw.some(r => r.payload.call_id === record.payload.call_id));
  const args = JSON.parse(record.payload.arguments);
  if (args.cmd) assert.match(args.cmd, /^[a-f0-9]{12}$/);
}
process.stdout.write(output);

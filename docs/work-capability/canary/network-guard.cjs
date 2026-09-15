"use strict";
// Installed only in the canary hook subprocess, never the Work agent itself.
function deny() {
  process.stderr.write("WORK-CANARY-NETWORK-BLOCKED\n");
  throw Error("work-canary-network-disabled");
}
global.fetch = deny;
require("node:net").Socket.prototype.connect = deny;
for (const module of ["node:http", "node:https"]) {
  require(module).request = deny;
  require(module).get = deny;
}
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  require("node:child_process")[name] = deny;
}

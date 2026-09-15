#!/usr/bin/env node
"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const cases = require("./cases.cjs");

async function main() {
  if (process.argv[2] === "--case") {
    const name = process.argv[3];
    if (!Object.hasOwn(cases, name)) throw Error("Unknown lifecycle case");
    const f = require("./fixture.cjs")();
    let result;
    try {
      await cases[name](f);
      result = {name, outcome:"pass"};
    } catch (error) {
      // Assertion labels contain only synthetic fixture data. Never emit store
      // contents, HTTP headers, stack traces or private runtime paths.
      result = {name, outcome:error.code === "ERR_ASSERTION" ? "fail" : "error", reason:error.code === "ERR_ASSERTION" ? error.message.split("\n")[0] : "Fixture or production operation failed"};
    }
    if (f.violations.length) result = {name, outcome:"error", reason:"Isolation guard rejected an unscripted operation"};
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = result.outcome === "pass" ? 0 : 1;
    return;
  }
  if (process.argv.length !== 2) throw Error("Usage: node run.cjs (no network or credentials needed)");
  const results = [];
  for (const name of Object.keys(cases)) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-lifecycle-"));
    try {
      fs.writeFileSync(path.join(root,"empty-gitconfig"), "");
      const child = spawnSync(process.execPath, [__filename, "--case", name], {
        cwd:root, timeout:10000, encoding:"utf8", maxBuffer:256*1024,
        // Allow-list avoids inheriting tokens, NODE_OPTIONS, plugin roots,
        // Git config overrides or the user's Codex/session state.
        env:{PATH:process.env.PATH, HOME:root, USERPROFILE:root, CODEX_HOME:path.join(root,"codex"),
          SKILLMETER_STATE_DIR:path.join(root,"state"), PLUGIN_DATA:path.join(root,"data"),
          GIT_CONFIG_NOSYSTEM:"1", GIT_CONFIG_GLOBAL:path.join(root,"empty-gitconfig"), SKILLMETER_LIFECYCLE_CHILD:"1"},
      });
      let result;
      try { result = JSON.parse(child.stdout.trim()); } catch {}
      if (!result || result.name !== name || !["pass","fail","error"].includes(result.outcome) ||
          child.status !== (result.outcome === "pass" ? 0 : 1)) {
        result = {name, outcome:"error", reason:"Child failed, timed out or returned an invalid result"};
      }
      results.push(result);
    } finally { fs.rmSync(root, {recursive:true, force:true}); }
  }
  const counts = Object.fromEntries(["pass","fail","error"].map(outcome => [outcome, results.filter(r => r.outcome === outcome).length]));
  process.stdout.write(JSON.stringify({schema_version:1, suite:"ADR001 offline acceptance", reference:"Claude 0.34.1 / ADR001 decisions 2-4", counts, results}, null, 2) + "\n");
  process.exitCode = counts.fail || counts.error ? 1 : 0;
}
main().catch(() => { process.stderr.write("Lifecycle runner failed before reporting\n"); process.exitCode = 2; });

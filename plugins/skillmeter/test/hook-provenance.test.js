"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Exercise the real stdin hook boundary and durable gzip delivery in a fresh
// process. The child cannot use Keychain, gh, detached workers, or real HTTP.
const child = String.raw`
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
require("node:os").homedir = () => process.env.HOME;
require("node:child_process").execSync = () => { throw Error("External shell disabled"); };
require("node:child_process").spawn = () => { throw Error("Detached workers disabled"); };
require("node:net").Socket.prototype.connect = () => { throw Error("Network disabled"); };
global.fetch = () => { throw Error("Unscripted HTTP disabled"); };
const logger = require(process.env.FIXTURE_PLUGIN + "/scripts/logger");
const policy = require(process.env.FIXTURE_PLUGIN + "/scripts/lib/telemetry-store");
if (process.env.FIXTURE_MODE !== "undecided") policy.authorizeOrganizationRepositories("synthetic", ["synthetic/shared"], true);
if (process.env.FIXTURE_MODE === "off") policy.setRepositoryOverride("synthetic/shared", false);
logger.runHook("UserPromptSubmit", input => ({
  prompt: input.prompt,
  repo_name: "spoofed/private", repo_scope: "spoofed",
  _sanitization: { counts: { secret: 999 } },
}), { afterLog: async () => {
  const file = logger.sealEventLog();
  const queued = fs.readFileSync(file, "utf8");
  global.fetch = async (url, options) => {
    assert.equal(url, "https://synthetic.meter.skillbench.ai/logs/codex");
    assert.ok(options.headers.Authorization.startsWith("Bearer e30."));
    const delivered = require("node:zlib").gunzipSync(options.body).toString();
    assert.equal(delivered, queued);
    fs.writeFileSync(path.join(process.env.HOME, "delivered.jsonl"), delivered);
    return {ok: true};
  };
  assert.equal(await logger.transferEventLog(file), "sent");
}}).catch(() => process.exit(1));
`;

for (const mode of ["clean", "redacted", "off", "undecided", "wrong-org"]) {
  test(`hook provenance survives queue and upload: ${mode}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hook-provenance-"));
    try {
      const repo = path.join(root, "repo"), state = path.join(root, "state");
      fs.mkdirSync(state);
      const claims = {exp:4102444800, github_id:123, org:{login:"synthetic"}, aud:"https://synthetic.meter.skillbench.ai"};
      fs.writeFileSync(path.join(state, "credentials.json"), JSON.stringify({device_id:"SYNTHETIC", hash_salt:"fixture", license_jwt:"e30." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".fixture"}));
      const env = {PATH:process.env.PATH, HOME:root, USERPROFILE:root, CODEX_HOME:path.join(root,"codex"), SKILLMETER_STATE_DIR:state, PLUGIN_DATA:path.join(root,"data"), GIT_CONFIG_NOSYSTEM:"1", GIT_CONFIG_GLOBAL:path.join(root,"empty-gitconfig"), FIXTURE_MODE:mode, FIXTURE_PLUGIN:path.resolve(__dirname,"..")};
      fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "");
      execFileSync("git", ["init", "--quiet", repo], {env});
      execFileSync("git", ["-C", repo, "remote", "add", "origin", `https://github.com/${mode === "wrong-org" ? "excluded" : "synthetic"}/shared.git`], {env});
      const prompt = mode === "redacted" ? "Contact alice@example.com" : "Count the files";
      execFileSync(process.execPath, ["-e", child], {env, cwd:repo, input:JSON.stringify({cwd:repo, session_id:"synthetic-session", prompt}), timeout:10000, stdio:["pipe","pipe","pipe"]});
      const delivered = path.join(root,"delivered.jsonl");
      if (["off", "undecided", "wrong-org"].includes(mode)) {
        assert.equal(fs.existsSync(delivered), false);
        const files = fs.existsSync(env.PLUGIN_DATA) ? fs.readdirSync(env.PLUGIN_DATA, {recursive:true}) : [];
        assert.equal(files.some(f => /events\.jsonl/.test(f)), false);
        return;
      }
      const raw = fs.readFileSync(delivered, "utf8");
      const event = JSON.parse(raw.trim());
      const data = event.data;
      assert.equal(data.repo_name, "synthetic/shared");
      assert.notEqual(data.repo_scope, "spoofed");
      assert.equal(data._sanitization.policyVersion, "3.1.0");
      assert.ok(data._sanitization.counts);
      assert.equal(raw.includes("spoofed/private"), false);
      assert.equal(raw.includes("alice@example.com"), false);
      if (mode === "clean") {
        assert.equal(data._sanitization.pii, 0);
        for (const [kind, count] of Object.entries(data._sanitization.counts)) {
          if (kind !== "path") assert.equal(count, 0, `zero count for ${kind}`);
        }
      }
      else assert.ok(data._sanitization.pii > 0);
      assert.notEqual(data._sanitization.counts.secret, 999);
    } finally { fs.rmSync(root, {recursive:true, force:true}); }
  });
}

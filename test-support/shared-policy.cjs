"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const plugin = path.resolve(__dirname, "../plugins/skillmeter");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-shared-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo"), state = path.join(root, ".skillbench");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git/config"), '[remote "origin"]\nurl = https://github.com/acme/widgets.git\n');
  fs.mkdirSync(path.join(repo, ".codex"));
  fs.writeFileSync(path.join(repo, ".codex/settings.local.json"), '{"skillmeter":{"telemetry":true}}');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, "credentials.json"), JSON.stringify({
    device_id: "SYNTHETIC", hash_salt: "fixture-salt", allowed_github_orgs: ["acme"],
    license_jwt: "e30." + Buffer.from(JSON.stringify({ sub: "tenant", github_id: "synthetic", exp: 4102444800, aud: "https://acme.meter.skillbench.ai" })).toString("base64url") + ".fixture",
  }));
  const policyFile = path.join(state, "telemetry-policy.json");
  const policy = (enabled = true, extra = {}) => ({ schema_version: 1, revision: 1,
    global: { enabled, decided_at: 1, source: "user" }, organizations: { acme: { enabled: true } },
    repositories: { "github.com/acme/widgets": { enabled: true } }, ...extra });
  function run(code, cwd = repo) {
    const prelude = `
      const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
      require('node:child_process').execSync = () => { throw Error('unexpected shell'); };
      require('node:child_process').spawn = () => ({ pid: 999999, unref() {} });
      global.fetch = async () => assert.fail('unexpected network');
      const logger = require(${JSON.stringify(path.join(plugin, "scripts/logger.js"))});
      const repo = process.cwd(), policyFile = ${JSON.stringify(policyFile)};
      const writePolicy = value => fs.writeFileSync(policyFile, JSON.stringify(value));
      const policy = ${JSON.stringify(policy())};
      const source = ${JSON.stringify(path.join(root, "synthetic.jsonl"))};
      const line = text => JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:text}})+'\\n';
      const stage = () => logger.stageTranscriptForUpload(source,{cwd:repo});
      const records = files => files.flatMap(file => require('node:zlib').gunzipSync(fs.readFileSync(file)).toString().trim().split('\\n').map(JSON.parse));
    `;
    const result = spawnSync(process.execPath, ["-e", prelude + "\n(async()=>{\n" + code + "\n})().catch(e=>{console.error(e);process.exitCode=1});"], {
      cwd, encoding: "utf8", timeout: 10000, input: JSON.stringify({ cwd, session_id: "synthetic", tool_name: "synthetic" }),
      env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, ".codex"),
        PLUGIN_ROOT: plugin, PLUGIN_DATA: path.join(root, "data"), SKILLMETER_STATE_DIR: state,
        SKILLMETER_REPO_SCOPE_ORGS: "", SKILLMETER_BACKEND_URL: "", NODE_OPTIONS: "" },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result;
  }
  const cli = args => run(`process.argv = ['node','telemetry.js',...${JSON.stringify(args)}]; require(${JSON.stringify(path.join(plugin, "scripts/telemetry.js"))});`);
  return { root, repo, state, policyFile, policy, run, cli };
}
module.exports = { fixture };

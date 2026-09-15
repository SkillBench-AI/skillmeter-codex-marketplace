"use strict";
// Loaded only in the runner's isolated child, before any production module.
const fs = require("node:fs"), path = require("node:path");
const assert = require("node:assert/strict");
module.exports = function fixture() {
  const root = process.env.HOME;
  assert.equal(process.env.SKILLMETER_LIFECYCLE_CHILD, "1");
  assert.equal(process.env.SKILLMETER_STATE_DIR, path.join(root, "state"));
  require("node:os").homedir = () => root;
  const trace = [], violations = [];
  const deny = operation => { violations.push(operation); throw Error(`Unscripted ${operation}`); };
  require("node:net").Socket.prototype.connect = () => deny("socket");
  const cp = require("node:child_process");
  cp.spawn = cp.spawnSync = cp.exec = cp.execFile = () => deny("child process");
  const git = cp.execFileSync;
  cp.execFileSync = (command, args, options) => {
    if (command !== "git") return deny("execFileSync");
    return git(command, args, options);
  };
  let ghAvailable = true, ghId = 123;
  cp.execSync = command => {
    if (command !== "gh auth token") return deny("shell/Keychain");
    trace.push("gh-token");
    if (!ghAvailable) throw Error("synthetic gh unavailable");
    return "synthetic-gh-credential";
  };
  const RealDate = Date;
  let now = RealDate.UTC(2030, 0, 1);
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  const token = (extra = {}) => "e30." + Buffer.from(JSON.stringify({
    exp: Math.floor(now / 1000) + 3600, github_id:123, sub:"synthetic-org",
    org:{login:"synthetic"}, aud:"https://synthetic.meter.skillbench.ai", ...extra,
  })).toString("base64url") + ".fixture";
  const credentialFile = path.join(root, "state/credentials.json");
  fs.mkdirSync(path.dirname(credentialFile), {recursive:true});
  fs.writeFileSync(credentialFile, JSON.stringify({device_id:"SYNTHETIC", hash_salt:"fixture", license_jwt:token()}));
  const logger = require("../../scripts/logger");
  const creds = require("../../scripts/credstore");
  const policy = require("../../scripts/lib/telemetry-store");
  const chunks = require("../../scripts/lib/transcript-delta");
  const repo = path.join(root, "repo");
  cp.execFileSync("git", ["init", "--quiet", repo]);
  cp.execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/synthetic/shared.git"]);
  process.chdir(repo);
  policy.authorizeOrganizationRepositories("synthetic", ["synthetic/shared"], true);
  const response = (status, body) => ({status, ok:status >= 200 && status < 300, json:async () => body, text:async () => "synthetic response"});
  let refresh = () => response(200, {token:token()}), activate = () => response(200, {token:token()});
  let delivery = () => response(503, {});
  global.fetch = async (url, options = {}) => {
    const route = new URL(url).pathname;
    trace.push(route);
    if (url === "https://api.skillbench.ai/refresh") return refresh();
    if (url === "https://api.skillbench.ai/activate") return activate();
    if (url === "https://api.github.com/user") return response(200, {id:ghId, login:"synthetic-user"});
    if (url === "https://api.github.com/user/orgs?per_page=100") return response(200, [{login:"synthetic"}]);
    if (["https://synthetic.meter.skillbench.ai/logs/codex", "https://synthetic.meter.skillbench.ai/logs/codex/transcript"].includes(url)) {
      assert.equal(options.headers.Authorization, `Bearer ${creds.getLicenseToken()}`);
      assert.equal(creds.isLicenseTokenExpired(creds.getLicenseToken(), 0), false, "never send with an expired token");
      return delivery();
    }
    return deny("HTTP route");
  };
  const source = path.join(root, "rollout.jsonl");
  fs.writeFileSync(source, "");
  // Establish consent before synthetic authored content exists.
  logger.stageTranscriptForUpload(source, {cwd:repo});
  const event = () => {
    logger.logInfo("UserPromptSubmit", "synthetic-session", {prompt:"synthetic event"}, "SYNTHETIC", logger.transcriptScope(repo));
    return logger.sealEventLog(repo);
  };
  const chunk = () => {
    fs.appendFileSync(source, JSON.stringify({type:"response_item", payload:{type:"message", role:"user", content:"synthetic transcript"}}) + "\n");
    return logger.stageTranscriptForUpload(source, {cwd:repo});
  };
  const status = () => {
    const file = path.join(root, "state/license-status.json");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null;
  };
  return {root, logger, creds, policy, chunks, repo, trace, violations, token, response, event, chunk, status,
    advance: ms => { now += ms; }, now: () => now,
    expire: () => creds.setLicenseToken(token({exp:Math.floor(now / 1000) - 1})),
    refresh: fn => { refresh = fn; }, activate: fn => { activate = fn; }, delivery: fn => { delivery = fn; },
    gh: (id, available = true) => { ghId = id; ghAvailable = available; },
    rememberSignin: () => { assert.equal(creds.commitSignin({jwt:token(), orgs:["synthetic"]}), true); },
    refreshLicense: () => logger.tryRefreshLicense("SYNTHETIC"),
    sweep: async () => {
      fs.mkdirSync(logger.LOG_DIR, {recursive:true});
      logger.refreshRetryDaemonLock();
      await require("../../scripts/monitors/retry_daemon").sweep();
    },
  };
};

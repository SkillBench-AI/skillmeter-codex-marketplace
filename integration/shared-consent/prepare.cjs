"use strict";
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const crypto = require("node:crypto");

function prepare(destination, claudeRepo) {
  const base = path.resolve(destination);
  const codexRepo = path.resolve(__dirname, "../..");
  if (fs.existsSync(base)) throw Error("Choose a new destination; existing directories are never replaced.");
  const git = (cwd, args, options = {}) => {
    const r = cp.spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", ...options });
    if (r.status !== 0) throw Error(r.stderr || "git failed");
    return r.stdout.trim();
  };
  const heads = { codex: git(codexRepo, ["rev-parse", "HEAD"]), claude: git(claudeRepo, ["rev-parse", "HEAD"]) };
  // Export committed files only, never a developer's dirty checkout or credentials.
  function snapshot(repo, head, prefix, target) {
    for (const file of git(repo, ["ls-tree", "-r", "--name-only", head, "--", prefix]).split("\n")) {
      if (!file.startsWith(prefix + "/")) throw Error("Missing plugin source");
      const relative = file.slice(prefix.length + 1);
      if (!/^(scripts\/|hooks\/|\.codex-plugin\/|\.claude-plugin\/)/.test(relative)) continue;
      const r = cp.spawnSync("git", ["-C", repo, "show", `${head}:${file}`], { maxBuffer: 16 * 1024 * 1024 });
      if (r.status !== 0) throw Error("Cannot export candidate");
      const output = path.join(target, relative);
      fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
      fs.writeFileSync(output, r.stdout, { mode: 0o600 });
    }
  }
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const write = (file, data) => fs.writeFileSync(path.join(base, file), data, { mode: 0o600 });
  for (const dir of ["home", "home/.skillbench", "data", "bindings", "received", "attempts", "templates"])
    fs.mkdirSync(path.join(base, dir), { recursive: true, mode: 0o700 });
  snapshot(codexRepo, heads.codex, "plugins/skillmeter", path.join(base, "codex"));
  snapshot(claudeRepo, heads.claude, "skillmeter", path.join(base, "claude"));
  const env = { PATH: process.env.PATH, HOME: path.join(base, "home"), GIT_CONFIG_NOSYSTEM: "1" };
  const workspaces = Object.fromEntries(["a", "clone", "worktree", "b"].map(k => [k, path.join(base, k)]));
  for (const label of ["a", "b"]) {
    const cwd = workspaces[label]; fs.mkdirSync(cwd);
    git(cwd, ["init", "--quiet"], { env });
    fs.writeFileSync(path.join(cwd, "source.csv"), "task,minutes\nread,15\nwrite,20\nverify,25\n");
    git(cwd, ["add", "source.csv"], { env });
    git(cwd, ["-c", "user.name=Synthetic Canary", "-c", "user.email=canary@example.invalid", "commit", "-qm", "Synthetic input"], { env });
    git(cwd, ["remote", "add", "origin", `https://github.com/acme/${label === "a" ? "widgets" : "other"}.git`], { env });
  }
  git(base, ["clone", "--quiet", "--no-hardlinks", workspaces.a, workspaces.clone], { env });
  git(workspaces.clone, ["remote", "set-url", "origin", "https://github.com/acme/widgets.git"], { env });
  git(workspaces.a, ["worktree", "add", "--quiet", "--detach", workspaces.worktree], { env });
  const harness = {};
  for (const name of ["run.cjs", "guard.cjs"]) {
    const bytes = fs.readFileSync(path.join(__dirname, name));
    write(name, bytes); harness[name] = crypto.createHash("sha256").update(bytes).digest("hex");
  }
  write("config.json", JSON.stringify({ base, heads, harness, workspaces, expiresAt: 0 }, null, 2));
  write("disabled", "Prepared, not armed.\n");
  write("receiver.json", '{"status":503}');
  const claims = { sub: "synthetic-tenant", github_id: "synthetic-user", exp: 4102444800, aud: "https://consent-canary.meter.dev" };
  write("home/.skillbench/credentials.json", JSON.stringify({ device_id: "SYNTHETIC", hash_salt: "synthetic-salt",
    allowed_github_orgs: ["acme"], license_jwt: "e30." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".fixture" }));
  write("home/.skillbench/telemetry-policy.json", JSON.stringify({ schema_version: 1, revision: 0,
    global: { enabled: true }, organizations: {}, repositories: {} }));
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  const hooks = JSON.parse(fs.readFileSync(path.join(base, "codex/hooks/hooks.json")));
  for (const [event, groups] of Object.entries(hooks.hooks)) {
    const script = event.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase() + ".js";
    for (const group of groups) for (const hook of group.hooks) {
      hook.command = `${quote(process.execPath)} ${quote(path.join(base, "run.cjs"))} hook ${script}`;
      hook.statusMessage = `Shared consent canary: ${event}`;
    }
  }
  write("templates/hooks.json", JSON.stringify(hooks, null, 2));
  return { base, heads, armed: false };
}
if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw Error("Usage: node prepare.cjs NEW_DIRECTORY CLAUDE_CHECKOUT");
    console.log(JSON.stringify(prepare(...process.argv.slice(2)), null, 2));
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
module.exports = { prepare };

"use strict";
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process"), crypto = require("node:crypto");
const base = __dirname, configFile = path.join(base, "config.json");
const cfg = JSON.parse(fs.readFileSync(configFile));
const [mode, arg, ...rest] = process.argv.slice(2);
const write = (file, value) => fs.writeFileSync(path.join(base, file), value, { mode: 0o600 });
const active = () => cfg.expiresAt > Date.now() && !fs.existsSync(path.join(base, "disabled"));
const workspace = label => { if (!Object.hasOwn(cfg.workspaces, label)) throw Error("Unknown workspace"); return cfg.workspaces[label]; };
function audit(value) {
  fs.appendFileSync(path.join(base, "callbacks.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n", { mode: 0o600 });
}
function environment() {
  return { PATH: process.env.PATH, LANG: "en_US.UTF-8", TMPDIR: process.env.TMPDIR || "/tmp",
    HOME: path.join(base, "home"), USERPROFILE: path.join(base, "home"), CODEX_HOME: path.join(base, "home/.codex"),
    PLUGIN_DATA: path.join(base, "data"), CLAUDE_PLUGIN_DATA: path.join(base, "data"),
    PLUGIN_ROOT: path.join(base, "codex"), CLAUDE_PLUGIN_ROOT: path.join(base, "claude"),
    SKILLMETER_STATE_DIR: path.join(base, "home/.skillbench"), SKILLMETER_REPO_SCOPE_ORGS: "", SKILLMETER_BACKEND_URL: "",
    NODE_OPTIONS: "--require " + JSON.stringify(path.join(base, "guard.cjs")) };
}
function child(args, cwd, input = "") {
  const r = cp.spawnSync(process.execPath, args, { cwd, env: environment(), input, encoding: "utf8", timeout: 2500 });
  process.stdout.write(r.stdout || ""); process.stderr.write(r.stderr || "");
  if (r.status !== 0) throw Error(r.error?.code || `Candidate exited ${r.status}`);
}
function main() {
  if (mode === "arm") {
    if (active()) throw Error("Already armed; retire before starting a new window");
    const template = fs.readFileSync(path.join(base, "templates/hooks.json"));
    for (const cwd of Object.values(cfg.workspaces)) if (fs.existsSync(path.join(cwd, ".codex/hooks.json"))) throw Error("Existing hooks must be reviewed, not overwritten");
    for (const cwd of Object.values(cfg.workspaces)) {
      fs.mkdirSync(path.join(cwd, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".codex/hooks.json"), template, { mode: 0o600, flag: "wx" });
    }
    cfg.expiresAt = Date.now() + 24 * 60 * 60 * 1000; write("config.json", JSON.stringify(cfg, null, 2));
    fs.rmSync(path.join(base, "disabled"), { force: true });
    console.log("Armed for 24 hours. Review project hooks manually; capture still needs session binding and consent."); return;
  }
  if (mode === "retire") {
    write("disabled", "Retired\n");
    const template = fs.readFileSync(path.join(base, "templates/hooks.json"));
    for (const cwd of Object.values(cfg.workspaces)) {
      const file = path.join(cwd, ".codex/hooks.json");
      if (fs.existsSync(file) && fs.readFileSync(file).equals(template)) fs.unlinkSync(file);
    }
    console.log("Retired; existing in-flight child work may finish. Evidence retained locally."); return;
  }
  if (mode === "status") {
    console.log(JSON.stringify({ heads: cfg.heads, armed: active(), expiresAt: cfg.expiresAt,
      bindings: fs.readdirSync(path.join(base, "bindings")).length,
      received: fs.readdirSync(path.join(base, "received")).filter(f => f.endsWith(".gz")).length }, null, 2)); return;
  }
  if (!active()) { if (mode === "hook") { console.log("{}"); return; } throw Error("Harness is not armed"); }
  if (mode === "bind") {
    const cwd = workspace(arg), [id, file] = rest;
    if (!id || !file) throw Error("bind LABEL SESSION_ID TRANSCRIPT_PATH");
    const source = fs.realpathSync(file), fd = fs.openSync(source, "r"), buffer = Buffer.alloc(65536);
    let length; try { length = fs.readSync(fd, buffer); } finally { fs.closeSync(fd); }
    const line = buffer.subarray(0, length).toString().split("\n")[0];
    const meta = JSON.parse(line);
    if (meta.type !== "session_meta" || meta.payload?.id !== id || meta.payload.cwd !== cwd) throw Error("Session identity/project mismatch");
    write(`bindings/${arg}.json`, JSON.stringify({ id, source }));
    console.log("Bound explicitly; repeat preflight before enabling capture."); return;
  }
  if (mode === "receiver") {
    if (!["200", "503"].includes(arg)) throw Error("receiver 200|503");
    write("receiver.json", JSON.stringify({ status: Number(arg) })); return;
  }
  if (mode === "local") {
    const cwd = workspace(arg);
    if (rest.length !== 1 || !["enable", "disable", "status"].includes(rest[0])) throw Error("local LABEL enable|disable|status");
    child([path.join(base, "codex/scripts/telemetry.js"), ...rest], cwd); return;
  }
  if (mode === "shared") {
    const code = `const s=require(${JSON.stringify(path.join(base, "claude/scripts/lib/telemetry-store.js"))});`;
    const enabled = rest.at(-1) === "on";
    if (!["on", "off"].includes(rest.at(-1))) throw Error("shared global|org on|off OR shared repo LABEL on|off");
    let call;
    if (arg === "global" && rest.length === 1) call = `s.setGlobalEnabled(${enabled});`;
    else if (arg === "org" && rest.length === 1) call = `s.setOrganizationConsent('acme',${enabled});`;
    else if (arg === "repo" && rest.length === 2) {
      workspace(rest[0]); const key = rest[0] === "b" ? "other" : "widgets";
      call = `s.setRepositoryOverride('github.com/acme/${key}',${enabled},s.getPolicyRevision());`;
    } else throw Error("Invalid shared control");
    child(["-e", code + call], workspace("a")); return;
  }
  if (mode !== "hook") throw Error("Unknown command");
  const allowed = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(base, "codex/hooks/hooks.json"))).hooks)
    .map(e => e.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase() + ".js"));
  if (!allowed.has(arg)) throw Error("Unknown hook script");
  const input = fs.readFileSync(0, "utf8"), h = JSON.parse(input);
  const label = Object.keys(cfg.workspaces).find(k => cfg.workspaces[k] === h.cwd);
  if (!label || typeof h.session_id !== "string") { console.log("{}"); return; }
  const bindingFile = path.join(base, "bindings", label + ".json");
  const binding = fs.existsSync(bindingFile) ? JSON.parse(fs.readFileSync(bindingFile)) : null;
  const sources = [h.transcript_path, h.agent_transcript_path].filter(Boolean);
  const real = p => { try { return fs.realpathSync(p); } catch { return null; } };
  if (!binding || binding.id !== h.session_id || sources.some(p => real(p) !== binding.source)) {
    audit({ label, hook: arg, outcome: "unselected", sessionHash: crypto.createHash("sha256").update(h.session_id).digest("hex") });
    console.log("{}"); return;
  }
  // Pin the selected source even on callbacks that omit transcript_path.
  h.transcript_path = binding.source;
  child([path.join(base, "codex/scripts", arg)], workspace(label), JSON.stringify(h));
  audit({ label, hook: arg, outcome: "candidate-completed" });
}
try { main(); } catch (err) {
  // No input or transcript content in diagnostics.
  console.error(`Canary operation failed (${err.code || "check-command-and-state"})`);
  if (mode === "hook") console.log("{}");
  process.exitCode = 1;
}

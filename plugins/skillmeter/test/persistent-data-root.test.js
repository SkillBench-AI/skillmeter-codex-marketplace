"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const plugin = path.resolve(__dirname, "..");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "plugins/data/skillmeter-fixture");
  const install = version => path.join(root, "plugins/cache/fixture/skillmeter", version);
  return { root, data, install };
}
function readRoot(f, install, extra = {}) {
  const program = `const logger = require(${JSON.stringify(path.join(plugin, "scripts/logger"))}); console.log(JSON.stringify({data:logger.PLUGIN_DATA,childData:process.env.PLUGIN_DATA}));`;
  return spawnSync(process.execPath, ["-e", program], { encoding: "utf8", env: {
    PATH: process.env.PATH, PLUGIN_ROOT: install, SKILLMETER_STATE_DIR: path.join(f.root, "identity"), ...extra,
  } });
}

test("logger keeps one persistent data root across versioned install replacement", t => {
  const f = fixture(t);fs.mkdirSync(path.dirname(f.data), { recursive: true });
  const old = f.install("old"), next = f.install("new");
  fs.mkdirSync(old, { recursive: true });fs.mkdirSync(next, { recursive: true });
  const first = readRoot(f, old);assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { data: f.data, childData: f.data });
  fs.mkdirSync(f.data, { recursive: true });
  fs.writeFileSync(path.join(f.data, "queue-marker"), "synthetic queue");
  fs.rmSync(old, { recursive: true });
  const second = readRoot(f, next);assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), { data: f.data, childData: f.data });
  assert.equal(fs.readFileSync(path.join(f.data, "queue-marker"), "utf8"), "synthetic queue");
  assert.equal(fs.existsSync(path.join(next, "logs")), false);
});

test("unresolved source checkout or unsubstituted data cannot write inside installation", t => {
  const f = fixture(t);
  for (const root of [f.root, f.install("new")]) {
    const result = readRoot(f, root, { PLUGIN_DATA: "${PLUGIN_DATA}" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /persistent-plugin-data-unavailable/);
    assert.equal(fs.existsSync(path.join(root, "logs")), false);
  }
});

test("host-supplied data and compatibility alias are propagated to detached children", t => {
  const f = fixture(t), selected = path.join(f.root, "explicit-data");
  for (const extra of [{ PLUGIN_DATA: selected }, { CLAUDE_PLUGIN_DATA: selected }, { PLUGIN_DATA: selected, CLAUDE_PLUGIN_DATA: path.join(f.root, "other") }]) {
    const result = readRoot(f, f.install("new"), extra);assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { data: selected, childData: selected });
  }
});

test("legacy state in an older cached install holds inference instead of stranding it", t => {
  const f = fixture(t), oldLogs = path.join(f.install("old"), "logs");
  fs.mkdirSync(path.dirname(f.data), { recursive: true });
  fs.mkdirSync(oldLogs, { recursive: true });
  const source = path.join(oldLogs, "events.jsonl");
  fs.writeFileSync(source, "synthetic retained event\n");
  const result = readRoot(f, f.install("new"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /legacy-install-data-recovery-required/);
  assert.equal(fs.readFileSync(source, "utf8"), "synthetic retained event\n");
  assert.equal(fs.existsSync(f.data), false);
});

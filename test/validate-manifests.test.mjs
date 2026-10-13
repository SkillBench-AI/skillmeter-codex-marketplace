import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const manifests = {
  "plugins/skillmeter/.codex-plugin/plugin.json": {
    name: "fixture", version: "1.0.0", description: "Synthetic plugin",
  },
  ".claude-plugin/marketplace.json": {
    plugins: [{ name: "fixture", source: { source: "local", path: "plugins/skillmeter" } }],
  },
  ".agents/plugins/marketplace.json": {
    plugins: [{ name: "fixture", source: { source: "local", path: "plugins/skillmeter" } }],
  },
};

function validate(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "manifest-validation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, ".github/scripts/validate-manifests.mjs");
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(new URL("../.github/scripts/validate-manifests.mjs", import.meta.url), script);
  for (const [relative, value] of Object.entries({ ...manifests, ...overrides })) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  }
  return spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 10000 });
}

test("manifest validator accepts valid object roots", (t) => {
  const result = validate(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /all manifests valid/);
});

for (const path of Object.keys(manifests)) {
  for (const value of [null, false, 0, "", true, "text", []]) {
    test(`manifest validator rejects ${JSON.stringify(value)} in ${path}`, (t) => {
      const result = validate(t, { [path]: value });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(result.stderr.includes(`${path}: expected a JSON object`), result.stderr);
      assert.doesNotMatch(result.stdout, /all manifests valid/);
    });
  }
}

#!/usr/bin/env node
// Structural validation of the marketplace + plugin manifests.
//
// This guards the metadata the Codex/Claude plugin browsers actually read, so a
// malformed manifest or a marketplace entry that points at a missing plugin
// directory is caught in CI instead of at install time. It is intentionally
// dependency-free (plain JSON parsing + filesystem checks).
//
// Usage: node .github/scripts/validate-manifests.mjs

import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const errors = [];
const checks = [];

function readJson(relPath) {
  const abs = resolve(repoRoot, relPath);
  try {
    return JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    errors.push(`${relPath}: invalid JSON (${err.message})`);
    return null;
  }
}

function isDir(absPath) {
  try {
    return existsSync(absPath) && statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

// --- Plugin manifest -------------------------------------------------------
const pluginManifestRel = "plugins/skillmeter/.codex-plugin/plugin.json";
const plugin = readJson(pluginManifestRel);
if (plugin) {
  for (const field of ["name", "version", "description"]) {
    if (typeof plugin[field] !== "string" || plugin[field].length === 0) {
      errors.push(`${pluginManifestRel}: missing/empty "${field}"`);
    }
  }
  checks.push(`plugin manifest "${plugin.name}" ok`);
}

// --- Marketplace manifests -------------------------------------------------
// Both browsers (Codex `.agents/`, Claude `.claude-plugin/`) must stay in sync
// and every declared local plugin must resolve to a real directory.
const marketplaceRels = [
  ".claude-plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
];

for (const rel of marketplaceRels) {
  const mp = readJson(rel);
  if (!mp) continue;
  if (!Array.isArray(mp.plugins) || mp.plugins.length === 0) {
    errors.push(`${rel}: "plugins" must be a non-empty array`);
    continue;
  }
  for (const entry of mp.plugins) {
    if (!entry || typeof entry.name !== "string") {
      errors.push(`${rel}: a plugin entry is missing a "name"`);
      continue;
    }
    const src = entry.source;
    if (src && src.source === "local" && typeof src.path === "string") {
      const abs = join(repoRoot, src.path);
      if (!isDir(abs)) {
        errors.push(
          `${rel}: plugin "${entry.name}" points at missing directory "${src.path}"`
        );
      }
    }
  }
  checks.push(`${rel} ok (${mp.plugins.length} plugin entr${mp.plugins.length === 1 ? "y" : "ies"})`);
}

if (errors.length > 0) {
  console.error("✗ manifest validation failed:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

for (const c of checks) console.log(`✓ ${c}`);
console.log("✓ all manifests valid");

#!/usr/bin/env node
// Turn a checkout of main into the internal channel build: the plugin defaults
// to the dev environment, and the marketplace is renamed so its installation,
// cache and data directory never collide with the stable channel's.
// Usage: node .github/scripts/make-internal-channel.mjs [repo-root]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
export const INTERNAL_MARKETPLACE = "skillbench-internal";

for (const manifest of [".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json"]) {
  const file = join(root, manifest);
  const marketplace = JSON.parse(readFileSync(file, "utf8"));
  if (marketplace.name !== "skillbench") throw new Error(`${manifest}: expected marketplace "skillbench", found "${marketplace.name}"`);
  marketplace.name = INTERNAL_MARKETPLACE;
  marketplace.interface = { ...marketplace.interface, displayName: "SkillBench (internal)" };
  writeFileSync(file, JSON.stringify(marketplace, null, 2) + "\n");
}

writeFileSync(join(root, "plugins/skillmeter/channel.json"),
  JSON.stringify({ channel: "internal", env: "dev" }, null, 2) + "\n");
console.log(`internal channel prepared in ${root}`);

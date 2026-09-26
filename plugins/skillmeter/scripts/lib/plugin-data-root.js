"use strict";
const fs = require("node:fs");
const path = require("node:path");

// Hooks supply PLUGIN_DATA; direct skills/monitors can instead use the known
// host cache layout. Never store durable queues in a versioned installation.
function resolvePluginDataRoot(pluginRoot, env = process.env) {
  const explicit = [env.PLUGIN_DATA, env.CLAUDE_PLUGIN_DATA]
    .find(value => typeof value === "string" && value && !value.includes("${"));
  let data = explicit ? path.resolve(explicit) : "";
  if (!data && pluginRoot) {
    const plugin = path.dirname(path.resolve(pluginRoot));
    const marketplace = path.dirname(plugin), cache = path.dirname(marketplace);
    const parent = path.join(path.dirname(cache), "data");
    if (path.basename(cache) === "cache") {
      try {
        if (fs.statSync(parent).isDirectory()) {
          // Old direct invocations may have written beside the executable. Do
          // not silently switch those queues to an empty persistent directory.
          for (const entry of fs.readdirSync(plugin, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const logs = path.join(plugin, entry.name, "logs");
            try {
              if (fs.readdirSync(logs).length) throw new Error("legacy-install-data-recovery-required");
            } catch (error) { if (error.code !== "ENOENT") throw error; }
          }
          data = path.join(parent, `${path.basename(plugin)}-${path.basename(marketplace)}`);
        }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  if (!data) throw new Error("persistent-plugin-data-unavailable");
  // Background drains inherit the exact resolved path, including when invoked
  // without the host's hook environment or with only its compatibility alias.
  env.PLUGIN_DATA = data;
  return data;
}
module.exports = { resolvePluginDataRoot };

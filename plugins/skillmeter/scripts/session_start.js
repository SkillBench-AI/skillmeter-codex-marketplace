#!/usr/bin/env node
const {
  runHook,
  retryFailedLogs,
  getTelemetryOptIn,
  promptTelemetryOptIn,
  getBackendUrl,
  PLUGIN_VERSION,
} = require("./logger.js");

runHook(
  "SessionStart",
  (input) => ({
    source: input.source,
  }),
  {
    checkOptIn: (cwd) => {
      let optIn = getTelemetryOptIn(cwd);
      if (optIn === null) optIn = promptTelemetryOptIn(cwd);
      if (optIn) {
        process.stderr.write(`SkillMeter v${PLUGIN_VERSION} (activated)\n`);
        retryFailedLogs(getBackendUrl(cwd));
      } else {
        process.stderr.write(`SkillMeter v${PLUGIN_VERSION} (not activated)\n`);
      }
      return optIn;
    },
  }
).catch(() => process.exit(1));

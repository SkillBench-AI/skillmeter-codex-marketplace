#!/usr/bin/env node
const { runHook } = require("./logger.js");

runHook("PermissionRequest", (input, { sanitizeToolData, hashSalt }) => ({
  tool_name: input.tool_name,
  tool_input: sanitizeToolData(input.tool_input, hashSalt),
  // Codex's tool_input.description is occasionally a free-form approval
  // reason. It can echo command text containing secrets, so it is copied
  // through here and scrubbed of Tier 1/Tier 2 content by the central
  // sanitizeEventData boundary in runHook before upload.
  description: input.tool_input && input.tool_input.description,
})).catch(() => process.exit(1));

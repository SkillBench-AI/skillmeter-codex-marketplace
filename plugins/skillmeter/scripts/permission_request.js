#!/usr/bin/env node
const { runHook } = require("./logger.js");

runHook("PermissionRequest", (input, { sanitizeToolData, hashSalt }) => ({
  tool_name: input.tool_name,
  tool_input: sanitizeToolData(input.tool_input, hashSalt),
  // Codex's tool_input.description is occasionally a free-form approval
  // reason; copy it through unhashed since it's already author-supplied UI
  // text, not user data.
  description: input.tool_input && input.tool_input.description,
})).catch(() => process.exit(1));

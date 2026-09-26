"use strict";
// Codex envelope adapter over the pinned Claude policy. Keep the shared engine,
// rules and path vocabulary unchanged; document the pin in docs/sanitizer-parity.md.
const fs = require("node:fs");
const shared = require("./lib/sanitize");
const { SECRET_PLACEHOLDER } = require("./lib/rules");

const OPAQUE_KEYS = new Set(["command", "cmd", "patch"]);
// A compaction reference names an already-sanitized queued record by its
// 64-hex identifier. The identifier is not content and must survive the
// content rules: a random hex string can look like a card number.
const REFERENCE_TYPE = "skillmeter_compaction_reference";
const REFERENCE_ID = /^[a-f0-9]{64}$/;
const REFERENCE_TOKEN = /^skillmeter:reference:(\d+)$/;

function prepare(value, salt, opaque, references) {
  if (Array.isArray(value)) return value.map(item => prepare(item, salt, opaque, references));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "_sanitization") continue; // raw input cannot supply provenance
    if (typeof item === "string" && (OPAQUE_KEYS.has(key) ||
        (key === "input" && value.type === "custom_tool_call"))) {
      out[key] = shared.hashHmac(item, salt);
      if (item && salt) opaque.push({ id: "codex-opaque-tool", category: "path", kind: "path", action: "hashed" });
    } else if (key === "source_uuid" && value.type === REFERENCE_TYPE && typeof item === "string" && REFERENCE_ID.test(item)) {
      out[key] = `skillmeter:reference:${references.push(item) - 1}`;
    } else {
      Object.defineProperty(out, key, {value: prepare(item, salt, opaque, references), enumerable: true, configurable: true, writable: true});
    }
  }
  return out;
}

function restoreReferences(value, references) {
  if (Array.isArray(value)) { value.forEach(item => restoreReferences(item, references)); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const match = key === "source_uuid" && value.type === REFERENCE_TYPE && typeof item === "string" && REFERENCE_TOKEN.exec(item);
    if (match && references[Number(match[1])]) value[key] = references[Number(match[1])];
    else restoreReferences(item, references);
  }
}

function sanitizeRecord(record, salt) {
  const opaque = [];
  const references = [];
  // Codex encodes function arguments as a JSON string. Parse only this known
  // protocol field so labelled secrets and path rules see its structure.
  let input = record;
  let argumentsWereJson = false;
  if (record?.type === "response_item" && record.payload?.type === "function_call" &&
      typeof record.payload.arguments === "string") {
    try {
      const args = JSON.parse(record.payload.arguments);
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("unsupported-arguments");
      input = { ...record, payload: { ...record.payload, arguments: args } };
      argumentsWereJson = true;
    } catch {
      // Invalid structured input has no safe field-level interpretation.
      // Keep the tool/call identity and report an opaque input instead.
      if (record.payload.arguments && salt) opaque.push({ id: "codex-opaque-tool", category: "path", kind: "path", action: "hashed" });
      input = { ...record, payload: { ...record.payload,
        arguments: shared.hashHmac(record.payload.arguments, salt),
        _codex_arguments_format:"unsupported-json-opaque" } };
    }
  }
  const result = shared.sanitizeEventData(prepare(input, salt, opaque, references), salt);
  if (references.length) restoreReferences(result.value, references);
  result.redactions.push(...opaque);
  result.meta = shared.summarizeRedactions(result.redactions);
  if (result.value && typeof result.value === "object" && !Array.isArray(result.value)) {
    result.value._sanitization = result.meta;
  }
  if (argumentsWereJson) result.value.payload.arguments = JSON.stringify(result.value.payload.arguments);
  return result;
}

function sanitizeLine(record, salt) {
  return sanitizeRecord(record, salt).value;
}

// Retained API for local export callers; the durable uploader uses complete
// byte records and rejects malformed lines in transcript-delta instead.
function sanitizeTranscript(file, salt) {
  const output = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    output.push(JSON.stringify(sanitizeLine(JSON.parse(line), salt)));
  }
  return Buffer.from(output.join("\n") + "\n");
}
// Compatibility helper for callers predating per-record metadata.
function redactDeep(value, redactions = [], salt) {
  const result = sanitizeRecord(value, salt);
  redactions.push(...result.redactions);
  if (result.value && typeof result.value === "object" && !Array.isArray(result.value)) {
    delete result.value._sanitization;
  }
  return result.value;
}
module.exports = {
  POLICY_VERSION: shared.POLICY_VERSION,
  SECRET_PLACEHOLDER,
  EMAIL_PLACEHOLDER: "[EMAIL]",
  redactString: shared.redactString,
  containsTier1: shared.containsSecret,
  hashHmac: shared.hashHmac,
  sanitizeEventData: sanitizeRecord,
  sanitizeLine,
  sanitizeTranscript,
  redactDeep,
};

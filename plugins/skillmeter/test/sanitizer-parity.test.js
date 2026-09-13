"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const s = require("../scripts/sanitizer");
const corpus = require("./fixtures/claude-3.1/pii-corpus.json");
for (const f of corpus.fixtures) test(`Claude PII parity: ${f.id}`, () => {
  const { value, redactions } = s.redactString(f.text);
  assert.equal(value, f.expect);
  assert.deepEqual([...new Set(redactions.filter(r => r.category === "pii").map(r => r.kind))].sort(), [...f.kinds].sort());
});
test("Codex records receive fresh policy metadata, preserving tool links and nested arguments", () => {
  const raw = { type:"response_item", payload:{type:"function_call", call_id:"synthetic-call", name:"read_file", arguments:JSON.stringify({file_path:"/private/project/src/fixture.ts", access_token:"unguessable-value", note:"用户@example.com"})}, _sanitization:{policyVersion:"3.1.0", secrets:0} };
  const before = JSON.stringify(raw);
  const out = s.sanitizeLine(raw, "synthetic-salt");
  assert.equal(JSON.stringify(raw), before);
  assert.equal(out.type, raw.type);
  assert.equal(out.payload.call_id, raw.payload.call_id);
  assert.equal(out.payload.name, "read_file");
  const args = JSON.parse(out.payload.arguments);
  assert.equal(args.access_token, "[REDACTED_SECRET]");
  assert.equal(args.note, "[EMAIL]");
  assert.match(args.file_path, /\/src\/[a-f0-9]{12}\.ts$/);
  assert.equal(out._sanitization.policyVersion, "3.1.0");
  assert.equal(out._sanitization.secrets, 1);
  assert.equal(out._sanitization.pii, 1);
  assert.ok(out._sanitization.counts.path > 0);
});
test("Codex keeps command and patch content opaque", () => {
  const out = s.sanitizeLine({type:"response_item", payload:{type:"function_call", call_id:"synthetic-call", name:"exec_command", arguments:JSON.stringify({command:"cat /private/fixture", patch:"private patch", timeout_ms:1000})}}, "synthetic-salt");
  const args = JSON.parse(out.payload.arguments);
  assert.match(args.command, /^[a-f0-9]{12}$/);
  assert.match(args.patch, /^[a-f0-9]{12}$/);
  assert.equal(args.timeout_ms, 1000);
});
test("unsupported tool arguments are opaque with an explicit format outcome", () => {
  for (const args of ['{"password":', '"raw argument"', '123', 'null', '[]']) {
    const out = s.sanitizeLine({type:"response_item", payload:{type:"function_call", call_id:"fixture", arguments:args}}, "synthetic-salt");
    assert.match(out.payload.arguments, /^[a-f0-9]{12}$/);
    assert.equal(out.payload._codex_arguments_format, "unsupported-json-opaque");
    assert.equal(out._sanitization.counts.path, 1);
    assert.equal(out.payload.call_id, "fixture");
  }
});
test("custom tool input stays opaque and source identity remains intact", () => {
  const raw = {type:"response_item", uuid:"synthetic-source", payload:{type:"custom_tool_call", name:"apply_patch", call_id:"fixture", input:"*** Begin Patch\nprivate contents"}};
  const out = s.sanitizeLine(raw, "synthetic-salt");
  assert.match(out.payload.input, /^[a-f0-9]{12}$/);
  assert.equal(out.uuid, raw.uuid);
  assert.equal(out.payload.call_id, "fixture");
});

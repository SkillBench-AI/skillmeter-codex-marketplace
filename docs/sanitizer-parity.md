# Codex sanitizer parity

The on-device engine, rule table and path vocabulary follow
[Claude ADR002](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/ac93536df5f7f272d6f9ececad5875ea3560b5ea/docs/adr/002-two-stage-sanitization.md),
policy **3.1.1**. Their bytes and the shared fixture corpora are pinned to Claude
commit `ac93536df5f7f272d6f9ececad5875ea3560b5ea` in
[`source.json`](../plugins/skillmeter/test/fixtures/claude-3.1/source.json).
`npm run check` verifies those hashes and runs the policy and queue tests.
Update shared policy in Claude first, then refresh these files and the pin.
Colliding keys receive record-local suffixes, with filename extensions preserved. These suffixes
do not establish file identity across records.

The Codex adapter handles differences in record format:

- Parse object-valued JSON `function_call.arguments`, sanitize its fields, and
  serialize it back to a JSON string. Preserve tool names and call/result IDs.
- Hash malformed or non-object argument strings whole and mark them
  `unsupported-json-opaque`; preserve the call identity.
- Keep command, cmd, patch and custom-tool input strings opaque with a device
  HMAC. This retains Codex's stricter command/patch treatment rather than
  adopting Claude's readable command content. These hashes count as paths.
- Discard incoming `_sanitization` metadata and derive counts from the current
  pass. Raw model or tool output cannot declare itself already sanitized.

Hook builders pass raw fields to one sanitizer boundary before the event queue.
Transcript staging sanitizes each complete record before compression and cursor
commit. Existing queued bytes keep their original policy version and retry
identity; this change does not rewrite them. The local export helper throws on
malformed JSON instead of returning an incomplete export.

Repository identity, consent, credentials and delivery remain governed by their
existing implementations. This adapter does not disclose repository names or
implement server-side stage-2 sanitization. Names and confidential free text can
remain after stage 1; sanitization is not an anonymity guarantee.

# Claude reference and Codex adapter

Pinned Claude commit: `0ea513751149a23fcc063fb8f045794657ceb031`, plugin 0.34.1,
sanitation policy 3.1.0. No new shared package or service is introduced.

| Claude source | SHA-256 of reference | Codex copy |
| --- | --- | --- |
| `scripts/lib/io.js` | `d8e351bd7acf2bc7c62564830bde6bbf080a82ce27b9400a760eadcdfef21687` | byte-identical |
| `scripts/lib/repo-scope.js` | `039a945d38b3f5bb179643d0818e16dc81c7fd7646688f9a279fa7a59391fb8d` | byte-identical |
| `scripts/lib/telemetry-policy.js` | `9c52f755a9a01960496642794fc9012160754168ba4e2a4a47757c15320b012b` | byte-identical |
| `scripts/lib/telemetry-store.js` | `ed0cc8bd4c27e4a74925f8d54bec5628defc0dc06ac77f0ef3916a461f616e65` | invalid/future-policy guard |
| `scripts/lib/sanitize.js` | `61e6517fd0b2f16eadd5866cc767a162fc833b161cfafaa4fd460393a13faa43` | byte-identical |
| `scripts/lib/rules.js` | `74f821d52450a7c7be7c10f2a2c1f6c5958a1d8e2314c8bcaebca83600ea0669` | byte-identical |
| `scripts/lib/path-vocabulary.json` | `ff133f66d53ae5c7d12c300725d6664d7cbe696fab27ad3c8129c0fceb4b3bd6` | byte-identical |

Secret and PII corpora in `plugins/skillmeter/test/fixtures/claude-3.1` are
byte-identical copies. `claude-sanitize.test.js` changes only the corpus path;
`claude-path-hashing.test.js` is unchanged. Codex adapter tests exercise all 67
PII fixtures through the public boundary and preserve source/tool identity.

The Codex adapter parses only response_item/function_call JSON arguments. It
retains their JSON-string shape. Commands (`cmd`/`command`), patches and custom
tool input stay whole hashes; their disclosure is not expanded to Claude's
content-preserving command policy. Every record receives fresh metadata. Unknown
argument shapes receive an explicit opaque outcome. Local export rejects
malformed JSON instead of silently dropping records. The old short fake GitHub
PAT test was replaced with the canonical 82-character fixture required by the
shared detector; no additional Codex-specific detector was invented.

Consent/store modules share Claude's on-disk schema and writer protocol. The
Codex guard rejects damaged/future policy files before capture or mutation. Host
paths, authenticated delivery and byte-based transcript cursors are adapters.
The fallback data directory is persistent `STATE_DIR/codex`; no plugin-cache
fallback or automatic historical migration remains.

Consented hook events include the derived clear `org/repo` in `repo_name`, as
allowed by ADR002 decision 7. Hook-specific data cannot override repository
identity. Offline stdin-to-queue-to-gzip tests verify the identity and fresh
policy 3.1.0 counts, including zeros; OFF, undecided and excluded repositories
produce no event payload. No additional transcript content is disclosed.

This candidate does not yet satisfy all accepted ADR001 requirements. Its token
lifecycle, per-file cross-repository consent (INF-195), stage-2 sanitization and
release ownership remain separate. See the checkpoint for live-canary gates.

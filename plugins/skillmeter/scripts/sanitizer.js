const crypto = require("crypto");
const fs = require("fs");

// ---------------------------------------------------------------------------
// Sanitization policy (SBEE-155, SANITIZATION_EPIC.md tasks 2.1 / 2.2b)
//
// Codex lifecycle hooks upload raw user content — the submitted `prompt`, the
// `last_assistant_message`, tool descriptions, tool arguments, tool output, and
// the full session transcript. None of that may leave the machine carrying a
// Tier 1 secret (api keys, tokens, private keys, .env credentials, …). This
// module is the single deterministic boundary that scrubs every string before
// it is written to the durable queue or staged for upload.
//
// Design rules drawn from the epic:
//   - Tier 1 is fail-closed: when a value looks like a secret we redact it. Over-
//     redacting is acceptable; leaking is not.
//   - We never store or log the original secret value — only its detector type,
//     tier, field location, and the action taken.
//   - Detection is deterministic regex, with a small allow-list for obvious
//     placeholders (`example`, `dummy`, `test-token`, …) to limit false
//     positives without weakening real-secret recall.
// ---------------------------------------------------------------------------

const POLICY_VERSION = "2.0.0";

const SECRET_PLACEHOLDER = "[REDACTED_SECRET]";
const EMAIL_PLACEHOLDER = "[EMAIL]";

// Obvious non-secret stand-ins. A matched value that is exactly one of these
// (case-insensitive) is left in place so example/doc text and test fixtures
// don't get needlessly redacted. Kept deliberately small — anything ambiguous
// errs toward redaction.
const PLACEHOLDER_ALLOWLIST = new Set([
  "example",
  "examples",
  "dummy",
  "test",
  "test-token",
  "testtoken",
  "placeholder",
  "redacted",
  "changeme",
  "your-token",
  "your-api-key",
  "your_api_key",
  "xxx",
  "xxxx",
  "xxxxxxxx",
  "none",
  "null",
  "undefined",
  "true",
  "false",
]);

function isPlaceholderValue(value) {
  if (!value) return true;
  const trimmed = String(value).trim().toLowerCase();
  if (!trimmed) return true;
  if (PLACEHOLDER_ALLOWLIST.has(trimmed)) return true;
  // All-x / all-asterisk masks like "xxxxxxxxxxxx" or "************".
  if (/^[x*•]+$/i.test(trimmed)) return true;
  // Repeated single character (e.g. "aaaaaaaa") carries no real entropy.
  if (/^(.)\1{5,}$/.test(trimmed)) return true;
  return false;
}

// Shannon entropy (bits per character). Detectors that opt in via a numeric
// `entropy` floor use this to reject low-entropy false positives — matching the
// Claude sanitizer's entropy gating so all surfaces behave identically.
function shannonEntropy(str) {
  if (!str) return 0;
  const freq = Object.create(null);
  for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
  let entropy = 0;
  for (const ch in freq) {
    const p = freq[ch] / str.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// ---------------------------------------------------------------------------
// Tier 1 detectors
//
// Each detector pairs a `type` label with a global regex. `value` describes
// which capture group holds the sensitive token: `whole` redacts the entire
// match; a number keeps the surrounding structure and redacts only that group
// (used for `KEY=value` assignments and `Authorization:` headers so the field
// name survives for analysis while the credential does not).
// ---------------------------------------------------------------------------

// `keywords` are lowercase mandatory substrings drawn from each rule's own
// regex prefixes — a cheap pre-filter that skips the rule when absent (perf,
// recall-neutral). `entropy` is a Shannon floor (bits/char) that rejects
// low-entropy false positives. Both mirror the Claude ruleset so every surface
// gates identically.
const TIER1_DETECTORS = [
  // PEM / SSH private key blocks — redact the whole multi-line block.
  {
    type: "private_key",
    re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    value: "whole",
    keywords: ["-----begin"],
  },
  // GitHub fine-grained PAT.
  { type: "github_token", re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g, value: "whole", keywords: ["github_pat_"] },
  // GitHub classic / OAuth / server / refresh tokens (ghp_, gho_, ghu_, ghs_, ghr_).
  { type: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, value: "whole", keywords: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"], entropy: 3 },
  // OpenAI / Anthropic style keys (sk-, sk-proj-, sk-ant-…).
  { type: "api_key", re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/g, value: "whole", keywords: ["sk-"], entropy: 3 },
  // Google API key.
  { type: "api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, value: "whole", keywords: ["aiza"] },
  // Google OAuth client id.
  { type: "google_oauth_client", re: /\b[0-9]+-[0-9A-Za-z_]{32}\.apps\.googleusercontent\.com\b/g, value: "whole", keywords: ["googleusercontent"] },
  // GitLab personal access token.
  { type: "gitlab_pat", re: /\bglpat-[0-9A-Za-z_-]{20}\b/g, value: "whole", keywords: ["glpat-"] },
  // Stripe secret / restricted key.
  { type: "stripe_key", re: /\b(?:sk|rk)_(?:test|live|prod)_[0-9A-Za-z]{10,99}\b/g, value: "whole", keywords: ["sk_", "rk_"] },
  // Twilio API key (SK + 32 hex). No keyword pre-filter — "sk" is too common a
  // substring to filter on; the specific regex + entropy gate suffice.
  { type: "twilio_key", re: /\bSK[0-9a-fA-F]{32}\b/g, value: "whole", entropy: 3 },
  // SendGrid API key.
  { type: "sendgrid_key", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, value: "whole", keywords: ["sg."] },
  // Mailgun API key.
  { type: "mailgun_key", re: /\bkey-[0-9a-zA-Z]{32}\b/g, value: "whole", keywords: ["key-"], entropy: 3 },
  // npm access token.
  { type: "npm_token", re: /\bnpm_[0-9A-Za-z]{36}\b/g, value: "whole", keywords: ["npm_"] },
  // PyPI upload token.
  { type: "pypi_token", re: /\bpypi-AgEIcHlwaS[A-Za-z0-9_-]{50,}\b/g, value: "whole", keywords: ["pypi-ageichlwas"] },
  // DigitalOcean token.
  { type: "digitalocean_token", re: /\bdo[oprv]_v1_[a-f0-9]{64}\b/g, value: "whole", keywords: ["doo_v1_", "dop_v1_", "dor_v1_", "dov_v1_"] },
  // HashiCorp Vault token.
  { type: "hashicorp_vault_token", re: /\bhv[bs]\.[A-Za-z0-9_-]{90,}\b/g, value: "whole", keywords: ["hvb.", "hvs."] },
  // AWS access key id.
  { type: "aws_access_key", re: /\bA(?:KIA|SIA|IDA|GPA|ROA|NPA|NVA)[A-Z0-9]{16}\b/g, value: "whole", keywords: ["akia", "asia", "aida", "agpa", "aroa", "anpa", "anva"], entropy: 3 },
  // Slack tokens.
  { type: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, value: "whole", keywords: ["xox"] },
  // Slack incoming webhook URL.
  { type: "slack_webhook", re: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,60}/g, value: "whole", keywords: ["hooks.slack.com"] },
  // JSON Web Tokens (header.payload.signature, base64url).
  {
    type: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    value: "whole",
    keywords: ["eyj"],
  },
  // Database connection strings that embed credentials (user:pass@host).
  {
    type: "database_url",
    re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s:/@]+:[^\s:/@]+@[^\s'"]+/g,
    value: "whole",
    keywords: ["://"],
  },
  // Any URL with embedded basic-auth credentials (user:pass@host). Runs before
  // the Tier-2 email pass so the whole credential URL is redacted wholesale.
  {
    type: "basic_auth_url",
    re: /\bhttps?:\/\/[^\s:/@]+:[^\s:/@]+@[^\s'"]+/g,
    value: "whole",
    keywords: ["://"],
  },
  // Authorization / Proxy-Authorization headers carrying a Bearer/Basic/token
  // credential — keep the scheme word, redact the credential (group 2).
  {
    type: "auth_header",
    re: /\b(Authorization|Proxy-Authorization)\s*[:=]\s*(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{8,})/gi,
    value: 2,
    keywords: ["authorization"],
  },
  // .env / shell style assignments: SOMETHING_KEY=…, *_TOKEN=…, PASSWORD=…,
  // SECRET=…. Keep the variable name, redact the value (group 2). The value
  // group stops at whitespace/quote so only the credential is removed.
  {
    type: "env_secret",
    re: /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|ACCESS[_-]?KEY|API[_-]?KEY))\s*[:=]\s*["']?([^\s"'`]{4,})["']?/gi,
    value: 2,
    entropy: 3,
  },
];

// ---------------------------------------------------------------------------
// Tier 2 detectors (identity)
//
// Tier 2 is harder and intentionally conservative here: only emails, which are
// reliably detectable. Names / customer dictionaries are out of scope for this
// boundary and tracked separately in the epic (task 3.x).
// ---------------------------------------------------------------------------

const TIER2_DETECTORS = [
  {
    type: "email",
    tier: "tier2",
    placeholder: EMAIL_PLACEHOLDER,
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    value: "whole",
  },
];

/**
 * Scan a single string and redact every Tier 1 secret then Tier 2 identifier.
 *
 * Returns `{ value, redactions }` where `redactions` is an array of
 * `{ type, tier, action }` events. Tier 1 runs first so a secret is removed
 * before the (broader) Tier 2 email pass can ever see it.
 *
 * No original secret value is ever returned, logged, or stored — only the
 * detector type and the action taken.
 */
function redactString(input) {
  if (typeof input !== "string" || input.length === 0) {
    return { value: input, redactions: [] };
  }

  let value = input;
  const redactions = [];

  const runDetector = ({ type, re, value: group, placeholder, tier, keywords, entropy }) => {
    // Keyword pre-filter: skip the rule entirely unless a cheap mandatory
    // substring is present (perf; recall-neutral because keywords are drawn
    // from the regex's own required prefixes).
    if (keywords && !keywords.some((k) => value.toLowerCase().includes(k))) return;
    const replacement = placeholder || SECRET_PLACEHOLDER;
    re.lastIndex = 0;
    value = value.replace(re, (match, ...groups) => {
      // groups = [...captures, offset, fullString]; trim the trailing two.
      const captures = groups.slice(0, -2);
      const candidate = group === "whole" ? match : captures[group - 1];
      if (isPlaceholderValue(candidate)) return match;
      // Entropy gate: reject low-entropy false positives for opted-in rules.
      if (entropy && shannonEntropy(candidate) < entropy) return match;

      redactions.push({ type, tier: tier || "tier1", action: "redacted" });

      if (group === "whole") return replacement;
      // Reconstruct the match with only the credential group replaced so the
      // field name / scheme word survives (e.g. `API_KEY=[REDACTED_SECRET]`).
      const idx = match.lastIndexOf(candidate);
      if (idx === -1) return replacement;
      return match.slice(0, idx) + replacement + match.slice(idx + candidate.length);
    });
  };

  for (const detector of TIER1_DETECTORS) runDetector(detector);
  for (const detector of TIER2_DETECTORS) runDetector(detector);

  return { value, redactions };
}

/**
 * True when a string contains at least one Tier 1 secret. Convenience wrapper
 * around redactString for fail-closed checks.
 */
function containsTier1(input) {
  return redactString(input).redactions.some((r) => r.tier === "tier1");
}

// Object-key names that force Tier-1 redaction of their string value even when
// the value matches no detector. Mirrors the Claude / session-collector
// scrubDeep key-name rule so a credential under an api_key/token/password key
// can't leak just because it lacks a recognizable token shape.
const SECRET_KEY_PATTERNS = [
  /api[_-]?key/i,
  /token/i,
  /password/i,
  /passwd/i,
  /secret/i,
  /credentials?/i,
  /auth/i,
  /bearer/i,
  /access[_-]?key/i,
];

function isSecretKey(key) {
  return typeof key === "string" && SECRET_KEY_PATTERNS.some((p) => p.test(key));
}

/**
 * Recursively walk any value (string / array / object) and redact every string
 * leaf. Returns `{ value, redactions }` with sanitized data and aggregate
 * redaction metadata. Keys are never scanned as content, but a key whose NAME
 * looks secret-labelled (api_key, token, password, …) forces Tier-1 redaction
 * of its string value unless the value is an obvious placeholder. The parent
 * key propagates through arrays. Non-plain values pass through untouched.
 */
function redactDeep(value, redactions = [], parentKey = null) {
  if (typeof value === "string") {
    if (parentKey && isSecretKey(parentKey) && !isPlaceholderValue(value)) {
      redactions.push({ type: "env_secret", tier: "tier1", action: "redacted" });
      return SECRET_PLACEHOLDER;
    }
    const res = redactString(value);
    for (const r of res.redactions) redactions.push(r);
    return res.value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, redactions, parentKey));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = redactDeep(val, redactions, key);
    }
    return out;
  }
  return value;
}

/**
 * Sanitize an event-data object before it is logged/uploaded. Returns the
 * sanitized clone plus a compact metadata summary suitable for attaching to the
 * event (`{ policyVersion, tier1, tier2, types }`) — counts and detector types
 * only, never original values.
 */
function sanitizeEventData(data) {
  const redactions = [];
  const value = redactDeep(data, redactions);
  const tier1 = redactions.filter((r) => r.tier === "tier1").length;
  const tier2 = redactions.filter((r) => r.tier === "tier2").length;
  const types = [...new Set(redactions.map((r) => r.type))].sort();
  return {
    value,
    redactions,
    meta: { policyVersion: POLICY_VERSION, tier1, tier2, types },
  };
}

function hashHmac(str, salt) {
  if (!str || !salt) return "";
  return crypto.createHmac("sha256", salt).update(str).digest("hex").slice(0, 12);
}

function sanitizeLine(obj, hashSalt) {
  if (obj && typeof obj === "object" && typeof obj.cwd === "string") {
    obj.cwd = hashHmac(obj.cwd, hashSalt);
  }
  if (["session_meta", "turn_context"].includes(obj?.type) && typeof obj.payload?.cwd === "string") {
    obj.payload = { ...obj.payload, cwd: hashHmac(obj.payload.cwd, hashSalt) };
  }
  // Redact Tier 1 secrets / Tier 2 identifiers from every string in the record.
  // A Codex transcript line carries full prompt/assistant/tool-output text, so
  // path hashing alone is not enough to keep raw secrets off the wire.
  return redactDeep(obj);
}

// Codex session transcripts are JSONL records similar in shape to Claude Code
// transcripts. We strip cwd/path-style fields, redact secrets/PII from every
// string, and emit a JSONL buffer the caller can gzip and POST.
function sanitizeTranscript(transcriptPath, hashSalt) {
  const raw = fs.readFileSync(transcriptPath, "utf8");
  const lines = raw.split("\n");
  const output = [];

  for (const line of lines) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      output.push(JSON.stringify(sanitizeLine(obj, hashSalt)));
    } catch {
      // Skip malformed JSONL lines rather than rejecting the entire transcript;
      // a corrupted line in a long-running Codex session would otherwise drop
      // the whole upload.
    }
  }

  return Buffer.from(output.join("\n") + "\n", "utf8");
}

module.exports = {
  POLICY_VERSION,
  SECRET_PLACEHOLDER,
  EMAIL_PLACEHOLDER,
  redactString,
  redactDeep,
  containsTier1,
  sanitizeEventData,
  sanitizeTranscript,
  sanitizeLine,
  hashHmac,
};

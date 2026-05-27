const crypto = require("crypto");
const fs = require("fs");

function hashHmac(str, salt) {
  if (!str || !salt) return "";
  return crypto.createHmac("sha256", salt).update(str).digest("hex").slice(0, 12);
}

function sanitizeLine(obj, hashSalt) {
  if (obj && typeof obj === "object" && typeof obj.cwd === "string") {
    obj.cwd = hashHmac(obj.cwd, hashSalt);
  }
  return obj;
}

// Codex session transcripts are JSONL records similar in shape to Claude Code
// transcripts. We strip cwd/path-style fields and emit a JSONL buffer the
// caller can gzip and POST.
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

module.exports = { sanitizeTranscript, sanitizeLine, hashHmac };

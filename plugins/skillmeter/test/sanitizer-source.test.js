"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const source = require("./fixtures/claude-3.1/source.json");

for (const file of source.files) {
  test(`Claude source pin: ${file.local}`, () => {
    const bytes = fs.readFileSync(path.join(__dirname, "..", file.local));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256,
      "Update the canonical Claude implementation and source pin together");
  });
}
test("adapter declares the pinned Claude policy", () => {
  assert.equal(require("../scripts/sanitizer").POLICY_VERSION, source.policyVersion);
});

"use strict";

/**
 * Edge-case unit tests for the deterministic sanitizer (SBEE-159). These
 * complement sanitization.test.js (which covers the happy-path detectors and
 * the end-to-end hook routing) by pinning down the boundary behaviours the
 * fail-closed policy depends on:
 *   - non-string / empty inputs must pass through without throwing
 *   - idempotency: re-running the sanitizer must not double-redact
 *   - aggregate metadata counts/types across multiple secrets
 *   - recursive structure preservation (arrays, nested objects, scalars)
 *   - Tier-2-only content must not be reported as a Tier 1 secret
 *
 * Run with:  node --test plugins/skillmeter/test/sanitizer-edge-cases.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const sanitizer = require("../scripts/sanitizer");

const R = sanitizer.SECRET_PLACEHOLDER;
const E = sanitizer.EMAIL_PLACEHOLDER;

const FAKE_OPENAI = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd";
const FAKE_GH = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// --- non-string / empty inputs ---------------------------------------------

test("redactString passes non-string inputs through untouched", () => {
  for (const input of [null, undefined, 42, true, false, { a: 1 }, ["x"]]) {
    const { value, redactions } = sanitizer.redactString(input);
    assert.deepEqual(value, input);
    assert.deepEqual(redactions, []);
  }
});

test("redactString on an empty string returns it with no redactions", () => {
  const { value, redactions } = sanitizer.redactString("");
  assert.equal(value, "");
  assert.deepEqual(redactions, []);
});

// --- idempotency -----------------------------------------------------------

test("redactString is idempotent: a second pass changes nothing", () => {
  const first = sanitizer.redactString(`token is ${FAKE_OPENAI} ok`).value;
  const second = sanitizer.redactString(first);
  assert.equal(second.value, first);
  assert.deepEqual(second.redactions, []);
  assert.ok(first.includes(R));
});

test("the redaction placeholder itself is not re-redacted", () => {
  const { redactions } = sanitizer.redactString(`leftover ${R} marker`);
  assert.deepEqual(redactions, []);
});

// --- multiple secrets / aggregate metadata ---------------------------------

test("redactString redacts multiple distinct secrets in one string", () => {
  const { value, redactions } = sanitizer.redactString(
    `gh=${FAKE_GH} and openai=${FAKE_OPENAI}`
  );
  assert.equal(value.includes(FAKE_GH), false);
  assert.equal(value.includes(FAKE_OPENAI), false);
  assert.equal(redactions.length, 2);
  assert.ok(redactions.every((r) => r.tier === "tier1"));
});

test("sanitizeEventData reports deduped, sorted types and accurate counts", () => {
  const { value, meta } = sanitizer.sanitizeEventData({
    a: `first ${FAKE_GH}`,
    b: `second ${FAKE_GH}`,
    c: "email me at dev@example.org",
  });

  assert.equal(JSON.stringify(value).includes(FAKE_GH), false);
  assert.equal(JSON.stringify(value).includes("dev@example.org"), false);

  assert.equal(meta.tier1, 2, "two github tokens => tier1 count 2");
  assert.equal(meta.tier2, 1, "one email => tier2 count 1");
  // Types are a de-duplicated, sorted set.
  assert.deepEqual(meta.types, ["email", "github_token"]);
});

test("sanitizeEventData on clean data reports zero redactions", () => {
  const { value, meta } = sanitizer.sanitizeEventData({
    prompt: "please refactor the billing module",
    count: 5,
  });
  assert.equal(meta.tier1, 0);
  assert.equal(meta.tier2, 0);
  assert.deepEqual(meta.types, []);
  assert.equal(value.count, 5);
});

// --- recursive structure preservation --------------------------------------

test("redactDeep preserves scalar types and array/object shape", () => {
  const input = {
    n: 1,
    b: true,
    nul: null,
    arr: [1, "ok", { path: "/x", secret: FAKE_OPENAI }],
  };
  const redactions = [];
  const out = sanitizer.redactDeep(input, redactions);

  assert.equal(out.n, 1);
  assert.equal(out.b, true);
  assert.equal(out.nul, null);
  assert.equal(out.arr[0], 1);
  assert.equal(out.arr[1], "ok");
  assert.equal(out.arr[2].path, "/x");
  assert.equal(out.arr[2].secret.includes("sk-"), false);
  assert.equal(redactions.length, 1);
});

test("redactDeep scrubs strings in a top-level array", () => {
  const redactions = [];
  const out = sanitizer.redactDeep([`a ${FAKE_GH}`, "clean"], redactions);
  assert.equal(out[0].includes(FAKE_GH), false);
  assert.equal(out[1], "clean");
  assert.equal(redactions.length, 1);
});

// --- Tier separation -------------------------------------------------------

test("containsTier1 is false for Tier-2-only (email) content", () => {
  assert.equal(sanitizer.containsTier1("reach me at a@b.com"), false);
  assert.equal(sanitizer.containsTier1(`secret ${FAKE_OPENAI}`), true);
});

test("emails are reported as tier2 and not counted as secrets", () => {
  const { meta } = sanitizer.sanitizeEventData({ note: "x@y.io and a@b.com" });
  assert.equal(meta.tier1, 0);
  assert.equal(meta.tier2, 2);
});

// --- env-style assignment edges --------------------------------------------

test("env_secret keeps the variable name and redacts only the value", () => {
  const { value, redactions } = sanitizer.redactString("MY_API_KEY=supersecretvalue123");
  assert.match(value, /^MY_API_KEY=/);
  assert.equal(value.includes("supersecretvalue123"), false);
  assert.ok(value.endsWith(R));
  assert.equal(redactions[0].type, "env_secret");
});

test("placeholder assignments stay; real-looking values are redacted", () => {
  assert.equal(sanitizer.redactString("API_KEY=changeme").redactions.length, 0);
  assert.ok(sanitizer.redactString("API_KEY=Zk9q1W8pLm4xVt2b").redactions.length >= 1);
});

// --- metadata never leaks the original value -------------------------------

test("redaction metadata carries no original secret material", () => {
  const { redactions } = sanitizer.redactString(`x ${FAKE_OPENAI} y`);
  for (const r of redactions) {
    assert.deepEqual(Object.keys(r).sort(), ["action", "tier", "type"]);
    assert.equal(JSON.stringify(r).includes("sk-"), false);
  }
});

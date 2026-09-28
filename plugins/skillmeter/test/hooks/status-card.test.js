"use strict";
// The default status and consent results are short cards; details stay
// behind `status --details`.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { fixture } = require("../../../../test-support/consent-record.cjs");
const { statusBanner, consentSavedBanner } = require("../../scripts/lib/banner");

const widths = text => new Set(text.split("\n").filter(Boolean).map(line => [...line].length));

test("cards are boxes of one width", () => {
  const status = statusBanner({ capture: { state: "consent", text: "disabled; consent required" },
    repository: "acme/widgets", signIn: "OK", queue: "0 event batches · 0 transcript chunks pending" });
  const saved = consentSavedBanner({ kind: "organization", target: "@acme", enabled: true, revision: 1 });
  for (const text of [status, saved]) assert.equal(widths(text).size, 1, text);
  assert.match(status, /\[ CONSENT REQUIRED \][\s\S]*Reason +disabled; consent required/);
  assert.match(saved, /\[ ORGANIZATION ON \][\s\S]*→ Next: turn this repository on/);
});

test("status prints a short card and keeps diagnostics behind --details", t => {
  const f = fixture(t);
  f.run(`fs.writeFileSync(policyFile, JSON.stringify(policy));`);
  const card = f.cli(["status"]).stderr;
  assert.match(card, /\[ TELEMETRY ON \]/);
  assert.match(card, /Repository +acme\/widgets/);
  assert.doesNotMatch(card, /Reason|Capture policy:|Transcript diagnostics/);
  const details = f.cli(["status", "--details"]).stderr;
  assert.match(details, /Capture policy: eligible/);
});

test("status without consent names the reason and the next step", t => {
  const f = fixture(t);
  fs.rmSync(f.policyFile, { force: true });
  const card = f.cli(["status"]).stderr;
  assert.match(card, /\[ CONSENT REQUIRED \]/);
  assert.match(card, /Reason +disabled; organization and repository consent required/);
  assert.match(card, /→ Ask Codex to record SkillMeter consent/);
});

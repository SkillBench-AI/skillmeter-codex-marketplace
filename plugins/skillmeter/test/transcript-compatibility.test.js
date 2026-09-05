"use strict";

// M0 compatibility fixture. No credentials, local sessions, or network access.
// Strict red reproduction:
// SKILLBENCH_M0_STRICT=1 node --test plugins/skillmeter/test/transcript-compatibility.test.js
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "skillbench-m0-wire-"));
const previousData = process.env.PLUGIN_DATA;
process.env.PLUGIN_DATA = dataDir;
const credentialModule = require.resolve("../scripts/credstore");
const previousCredentials = require.cache[credentialModule];
require.cache[credentialModule] = {
  id: credentialModule,
  filename: credentialModule,
  loaded: true,
  exports: {
    getDeviceId: () => "M0-SYNTHETIC-DEVICE",
    getOrCreateHashSalt: () => "m0-fixture-only-salt",
    getLicenseToken: () => null,
    getTelemetryDisabled: () => false,
    setLicenseToken: () => assert.fail("Fixture must never change authentication"),
  },
};
const logger = require("../scripts/logger");
const realFetch = global.fetch;

after(() => {
  global.fetch = realFetch;
  if (previousData === undefined) delete process.env.PLUGIN_DATA;
  else process.env.PLUGIN_DATA = previousData;
  if (previousCredentials) require.cache[credentialModule] = previousCredentials;
  else delete require.cache[credentialModule];
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("M0: real staged request satisfies the collector chunk-header contract", {
  todo: process.env.SKILLBENCH_M0_STRICT === "1" ? false : "M1: legacy snapshots omit X-Chunk-Seq",
}, async (t) => {
  let request;
  // Mirrors only the missing-header rule in collector processor.go:121-124.
  // This is not execution of the Go handler or an end-to-end acceptance test.
  global.fetch = async (url, options) => {
    request = { url, ...options };
    const headers = new Headers(options.headers);
    return { ok: headers.has("x-chunk-seq"), status: headers.has("x-chunk-seq") ? 200 : 400 };
  };
  const fixture = path.join(__dirname, "fixtures", "codex-m0.jsonl");
  const pending = logger.stageTranscriptForUpload(fixture);
  assert.ok(pending, "actual sanitizer and staging must produce a pending file");
  const staged = fs.readFileSync(pending);
  const outcome = await logger.processPendingTranscript(
    pending, "M0-SYNTHETIC-DEVICE", "https://collector.invalid/logs/codex", 1000,
  );
  assert.ok(request, "actual uploader must issue a request to the in-memory stub");
  assert.equal(request.url, "https://collector.invalid/logs/codex/transcript");
  assert.equal(request.method, "POST");
  assert.deepEqual(zlib.gunzipSync(request.body), staged);
  assert.equal(staged.toString().trim().split("\n").length, 8);
  const headers = new Headers(request.headers);
  assert.equal(headers.get("x-device-id"), "M0-SYNTHETIC-DEVICE");
  assert.equal(headers.get("x-transcript-id"), "codex-m0.jsonl");
  assert.equal(headers.get("authorization"), null);
  const quarantined = fs.existsSync(path.join(logger.POISON_DIR, path.basename(pending)));
  t.diagnostic(JSON.stringify({ chunkSeq: headers.get("x-chunk-seq"), outcome, quarantined }));
  assert.match(headers.get("x-chunk-seq") || "", /^\d+$/, "collector requires X-Chunk-Seq");
  assert.equal(outcome, "sent");
  assert.equal(quarantined, false);
});

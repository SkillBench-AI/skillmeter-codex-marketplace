"use strict";
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-delivery-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.PLUGIN_DATA = path.join(root, "data");
delete process.env.SKILLMETER_BACKEND_URL;
const credentials = path.join(root, ".skillbench/credentials.json");
fs.mkdirSync(path.dirname(credentials));
const token = (extra = {}) => "e30." + Buffer.from(JSON.stringify({
  exp: 4102444800, aud: "https://synthetic.meter.skillbench.ai", github_id: 123,
  org: { login: "synthetic" }, ...extra,
})).toString("base64url") + ".fixture";
const save = jwt => fs.writeFileSync(credentials, JSON.stringify({
  device_id: "SYNTHETIC-DEVICE", hash_salt: "synthetic-salt", license_jwt: jwt,
}));
save(token());
const logger = require("../scripts/logger");
const realFetch = global.fetch;
let file;
beforeEach(() => {
  save(token());
  require("../scripts/credstore").refreshFromDisk();
  fs.mkdirSync(logger.LOG_DIR, { recursive: true });
  file = path.join(logger.LOG_DIR, "events.jsonl." + Date.now());
  fs.writeFileSync(file, '{"synthetic":true}\n');
  global.fetch = async () => assert.fail("unexpected network");
});
after(() => { global.fetch = realFetch; fs.rmSync(root, { recursive: true, force: true }); });

for (const [name, jwt] of [["missing", null], ["malformed", "invalid"], ["expired", token({ exp: 1 })]]) {
  test(`${name} credentials retain an event batch without a network request`, async () => {
    save(jwt);
    assert.equal(await logger.processSealedBatch(file), "auth");
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.existsSync(logger.batchMetaPath(file)), false);
  });
}
for (const status of [401, 402, 403]) {
  test(`HTTP ${status} retains event batch and credentials without anonymous retry`, async () => {
    const before = fs.readFileSync(credentials);
    let requests = 0;
    global.fetch = async (url, options) => {
      requests++;
      assert.equal(url, "https://synthetic.meter.skillbench.ai/logs/codex");
      assert.equal(options.headers.Authorization, `Bearer ${token()}`);
      return { ok: false, status };
    };
    assert.equal(await logger.processSealedBatch(file), "auth");
    assert.equal(requests, 1);
    assert.deepEqual(fs.readFileSync(credentials), before);
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.existsSync(logger.batchMetaPath(file)), false);
  });
}
for (const aud of [undefined, "http://synthetic.meter.skillbench.ai", "https://evil.invalid", "https://synthetic.meter.skillbench.ai/wrong-path", "https://user:password@synthetic.meter.skillbench.ai"]) {
  test(`invalid audience ${String(aud)} has no default destination`, () => {
    save(token({ aud }));
    require("../scripts/credstore").refreshFromDisk();
    assert.equal(logger.getBackendUrl(), null);
  });
}

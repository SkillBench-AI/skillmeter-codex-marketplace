"use strict";
// The bin/ entry points against isolated homes. Network sign-in is not exercised.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { PLUGIN_ROOT, tempDir, writeCredentials, makeJwt } = require("../../test-support/plugin.cjs");

function home(credentials) {
  const dir = tempDir("sk-bin-home");
  writeCredentials(dir, credentials);
  return dir;
}
function run(tool, args, dir) {
  return spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "bin", tool), ...args], {
    encoding: "utf8", env: { ...process.env, HOME: dir, USERPROFILE: dir },
  });
}
const readCredentials = dir => JSON.parse(fs.readFileSync(path.join(dir, ".skillbench", "credentials.json"), "utf8"));
const now = () => Math.floor(Date.now() / 1000);

test("sk-jwt reports no stored license when unauthenticated", () => {
  const result = run("sk-jwt", [], home({ device_id: "DEV-1", hash_salt: "abcd" }));
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no license JWT stored/i);
  assert.match(result.stdout, /DEV-1/);
});

test("sk-jwt renders claims for a valid token without leaking the raw token", () => {
  const jwt = makeJwt({ sub: "user-1", org: { id: "42", login: "acme", url: "https://github.com/acme" }, github_id: "99",
    aud: "https://acme.meter.skillbench.com", iat: now(), exp: now() + 3600 });
  const result = run("sk-jwt", [], home({ device_id: "DEV-1", hash_salt: "abcd", license_jwt: jwt }));
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Org login\s+acme/);
  assert.match(result.stdout, /Telemetry endpoint\s+https:\/\/acme\.meter\.skillbench\.com/);
  assert.match(result.stdout, /Status\s+valid/);
  assert.equal(result.stdout.includes(jwt), false, "raw JWT must not be printed");
});

test("sk-jwt flags an expired token", () => {
  const jwt = makeJwt({ sub: "u", aud: "https://x.meter.skillbench.com", exp: now() - 3600 });
  assert.match(run("sk-jwt", [], home({ device_id: "DEV-1", hash_salt: "abcd", license_jwt: jwt })).stdout, /EXPIRED/i);
});

test("signout drops the license and organizations, sets the global pause, and keeps the device identity", () => {
  const dir = home({ device_id: "DEV-1", hash_salt: "abcd", license_jwt: makeJwt({ sub: "u", exp: now() + 3600 }), allowed_github_orgs: ["acme"] });
  assert.equal(run("signout", [], dir).status, 0);
  const credentials = readCredentials(dir);
  assert.equal(credentials.license_jwt, undefined);
  assert.equal(credentials.allowed_github_orgs, undefined);
  assert.equal(credentials.signed_out, true);
  assert.equal(credentials.telemetry_disabled, true);
  assert.equal(credentials.device_id, "DEV-1");
  assert.equal(credentials.hash_salt, "abcd");
});

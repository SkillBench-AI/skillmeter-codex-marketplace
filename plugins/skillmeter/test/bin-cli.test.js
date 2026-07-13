"use strict";

/**
 * Unit tests for the auth/debug CLIs in bin/ (SBEE-159). These mirror the
 * Claude plugin's debug surface (sk-jwt, sk-refresh, sk-telemetry, signin,
 * signout) so a Codex user can inspect/refresh credentials and toggle telemetry
 * from a shell without an LLM round-trip.
 *
 * Each tool is exercised in an isolated HOME so the shared
 * ~/.skillbench/credentials.json is never touched. Network-touching flows
 * (signin / sk-refresh activation) are not driven here — we only assert the
 * local, side-effect-free behaviour (rendering, credstore mutations).
 *
 * Run with:  node --test plugins/skillmeter/test/bin-cli.test.js
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const { test } = require("node:test");
const assert = require("node:assert/strict");

const BIN_DIR = path.join(__dirname, "..", "bin");

function makeHome(creds) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sk-bin-home-"));
  if (creds) {
    fs.mkdirSync(path.join(home, ".skillbench"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".skillbench", "credentials.json"),
      JSON.stringify(creds) + "\n"
    );
  }
  return home;
}

function run(tool, args, home, extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(BIN_DIR, tool), ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv },
  });
}

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function readCreds(home) {
  return JSON.parse(
    fs.readFileSync(path.join(home, ".skillbench", "credentials.json"), "utf8")
  );
}

// --- sk-jwt ----------------------------------------------------------------

test("sk-jwt reports no stored license when unauthenticated", () => {
  const home = makeHome({ device_id: "DEV-1", hash_salt: "abcd" });
  const res = run("sk-jwt", [], home);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /no license JWT stored/i);
  assert.match(res.stdout, /DEV-1/);
});

test("sk-jwt renders claims for a valid token without leaking the raw token", () => {
  const now = Math.floor(Date.now() / 1000);
  const jwt = makeJwt({
    sub: "user-1",
    org: { id: "42", login: "acme", url: "https://github.com/acme" },
    github_id: "99",
    aud: "https://acme.meter.skillbench.com",
    iat: now,
    exp: now + 3600,
  });
  const home = makeHome({ device_id: "DEV-1", hash_salt: "abcd", license_jwt: jwt });

  const res = run("sk-jwt", [], home);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Org login\s+acme/);
  assert.match(res.stdout, /Telemetry endpoint\s+https:\/\/acme\.meter\.skillbench\.com/);
  assert.match(res.stdout, /Status\s+valid/);
  // The raw token body/signature must never be echoed.
  assert.equal(res.stdout.includes(jwt), false, "raw JWT must not be printed");
});

test("sk-jwt flags an expired token", () => {
  const now = Math.floor(Date.now() / 1000);
  const jwt = makeJwt({ sub: "u", aud: "https://x.meter.skillbench.com", exp: now - 3600 });
  const home = makeHome({ device_id: "DEV-1", hash_salt: "abcd", license_jwt: jwt });
  const res = run("sk-jwt", [], home);
  assert.match(res.stdout, /EXPIRED/i);
});

// --- sk-telemetry ----------------------------------------------------------

test("sk-telemetry status reports machine + repo-scope state", () => {
  const home = makeHome({ device_id: "DEV-1", hash_salt: "abcd" });
  const res = run("sk-telemetry", ["status"], home);
  assert.equal(res.status, 0);
  // telemetry.js writes its human-readable status to stderr.
  assert.match(res.stderr, /Global telemetry is enabled/);
  assert.match(res.stderr, /Repo scope/);
});

test("sk-telemetry disable --global flips the machine kill switch", () => {
  const home = makeHome({ device_id: "DEV-1", hash_salt: "abcd" });
  const res = run("sk-telemetry", ["disable", "--global"], home);
  assert.equal(res.status, 0);
  assert.equal(readCreds(home).telemetry_disabled, true);
});

// --- signout ---------------------------------------------------------------

test("signout drops the license and enables the global kill switch", () => {
  const home = makeHome({
    device_id: "DEV-1",
    hash_salt: "abcd",
    license_jwt: makeJwt({ sub: "u", exp: Math.floor(Date.now() / 1000) + 3600 }),
    allowed_github_orgs: ["acme"],
  });
  const res = run("signout", [], home);
  assert.equal(res.status, 0);

  const creds = readCreds(home);
  assert.equal(creds.license_jwt, undefined, "license JWT should be cleared");
  assert.equal(creds.allowed_github_orgs, undefined, "org list should be cleared");
  assert.equal(creds.signed_out, true);
  assert.equal(creds.telemetry_disabled, true);
  // Machine identity is preserved across signout.
  assert.equal(creds.device_id, "DEV-1");
  assert.equal(creds.hash_salt, "abcd");
});

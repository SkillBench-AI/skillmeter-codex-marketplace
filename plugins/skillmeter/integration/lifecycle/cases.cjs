"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs");
const cases = {};
const retained = file => assert.ok(file && fs.existsSync(file), "synthetic queued payload must remain");
const purged = file => assert.equal(fs.existsSync(file), false, "unsent synthetic payload must be deleted");
const noActivate = f => assert.equal(f.trace.includes("/activate"), false, "must not activate");
const terminal = (f, reason) => assert.equal(f.status()?.terminal?.reason, reason, "persist the shared lifecycle status reason");

cases["healthy-token-no-http"] = async f => {
  await f.refreshLicense();
  assert.deepEqual(f.trace, []);
};
cases["empty-queue-background-refresh"] = async f => {
  f.expire();
  await f.sweep();
  assert.deepEqual(f.trace, ["/refresh"]);
  assert.equal(f.creds.isLicenseTokenExpired(f.creds.getLicenseToken()), false);
};
cases["concurrent-refresh-single-flight"] = async f => {
  f.expire();
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  f.refresh(async () => { await ready; return f.response(200, {token:f.token()}); });
  const first = f.refreshLicense(), second = f.refreshLicense();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(f.trace, ["/refresh"], "concurrent callers must share one refresh attempt");
};
for (const kind of ["event", "chunk"]) {
  cases[`expired-token-captures-${kind}`] = async f => {
    f.expire();
    retained(f[kind]());
    assert.deepEqual(f.trace, []);
  };
}
cases["expired-token-never-delivers"] = async f => {
  const event = f.event(), chunk = f.chunk();
  retained(event); retained(chunk);
  f.expire();
  await f.logger.drainQueuesOnce();
  assert.deepEqual(f.trace, []);
  retained(event); retained(chunk);
};
cases["refresh-recovers-both-queues"] = async f => {
  const event = f.event(), chunk = f.chunk();
  retained(event); retained(chunk);
  f.expire();
  f.delivery(() => f.response(200, {}));
  await f.sweep();
  assert.equal(f.trace[0], "/refresh");
  assert.deepEqual(f.trace.slice(1).sort(), ["/logs/codex", "/logs/codex/transcript"]);
  purged(event); purged(chunk);
};
for (const failure of ["network", "404", "503", "malformed"]) {
  cases[`transient-${failure}-refresh-only`] = async f => {
    f.expire();
    const before = f.creds.getLicenseToken();
    f.refresh(() => {
      if (failure === "network") throw Error("synthetic offline");
      if (failure === "malformed") return {ok:true, status:200, json:async () => {throw Error("synthetic malformed");}};
      return f.response(Number(failure), {});
    });
    await f.refreshLicense();
    noActivate(f);
    assert.equal(f.creds.getLicenseToken(), before, "transient failures keep the token");
    assert.ok(f.status()?.next_retry_at > f.now(), "persist failure backoff");
  };
}
cases["no-prior-signin-no-silent-activation"] = async f => {
  f.creds.setLicenseToken(null);
  await f.refreshLicense();
  noActivate(f);
  assert.equal(f.creds.getLicenseToken(), null);
};
cases["signed-out-stays-signed-out"] = async f => {
  f.rememberSignin(); f.creds.signOut();
  await f.refreshLicense();
  assert.deepEqual(f.trace, []);
  assert.equal(f.creds.getLicenseToken(), null);
};
cases["prior-signin-validates-gh-before-activation"] = async f => {
  f.rememberSignin(); f.creds.setLicenseToken(null);
  await f.refreshLicense();
  const user = f.trace.indexOf("/user"), activate = f.trace.indexOf("/activate");
  assert.ok(user >= 0 && activate > user, "verify current GitHub ID before exchanging its credential");
  assert.ok(f.creds.getLicenseToken(), "matching prior identity may recover");
};
cases["changed-gh-identity-blocks-activation"] = async f => {
  f.rememberSignin(); f.creds.setLicenseToken(null); f.gh(456);
  await f.refreshLicense();
  noActivate(f);
  assert.equal(f.creds.getLicenseToken(), null);
  terminal(f, "identity_mismatch");
};
for (const [field, extra] of Object.entries({github_id:{github_id:456}, subject:{sub:"other-org"}, organization:{org:{login:"other"}}, audience:{aud:"https://other.meter.skillbench.ai"}})) {
  cases[`minted-${field}-mismatch-discarded`] = async f => {
    f.rememberSignin(); f.creds.setLicenseToken(null);
    f.activate(() => f.response(200, {token:f.token(extra)}));
    await f.refreshLicense();
    assert.equal(f.creds.getLicenseToken(), null, "mismatching minted identity must not be committed");
    terminal(f, "identity_mismatch");
  };
}
for (const code of [401, 410]) {
  cases[`refresh-${code}-identity-bound-reactivation`] = async f => {
    f.rememberSignin(); f.expire();
    f.refresh(() => f.response(code, {}));
    await f.refreshLicense();
    assert.equal(f.trace[0], "/refresh");
    assert.ok(f.trace.indexOf("/user") > 0 && f.trace.indexOf("/activate") > f.trace.indexOf("/user"), "check identity before reactivation");
    assert.equal(f.creds.isLicenseTokenExpired(f.creds.getLicenseToken()), false);
  };
}
for (const kind of ["event", "chunk"]) {
  cases[`signout-purges-${kind}`] = async f => {
    const file = f[kind](); retained(file);
    f.creds.signOut();
    purged(file);
  };
  for (const route of ["refresh", "activate"]) {
    cases[`${route}-402-purges-${kind}`] = async f => {
      const file = f[kind](); retained(file); f.rememberSignin();
      if (route === "refresh") f.expire();
      else f.creds.setLicenseToken(null);
      f[route](() => f.response(402, {}));
      await f.refreshLicense();
      purged(file);
      terminal(f, "revoked");
      const calls = f.trace.length;
      f.advance(60 * 60_000); await f.refreshLicense();
      assert.equal(f.trace.length, calls, "revoked state stops retries");
    };
  }
  cases[`seven-day-retention-${kind}`] = async f => {
    const file = f[kind](); retained(file);
    // File mtime and event seal time both begin at the fake clock's epoch.
    fs.utimesSync(file, f.now() / 1000, f.now() / 1000);
    f.advance(6 * 86400000); f.logger.cleanupStaleFiles(); retained(file);
    f.advance(2 * 86400000); f.logger.cleanupStaleFiles(); purged(file);
  };
}
for (const level of ["repository", "organization"]) {
  cases[`${level}-revocation-purges-both-queues`] = async f => {
    const event = f.event(), chunk = f.chunk(); retained(event); retained(chunk);
    if (level === "repository") f.policy.setRepositoryOverride("synthetic/shared", false);
    else f.policy.setOrganizationConsent("synthetic", false);
    await f.logger.drainQueuesOnce();
    purged(event); purged(chunk);
    assert.deepEqual(f.trace, []);
  };
}
cases["gh-unavailable-terminal-status"] = async f => {
  f.rememberSignin(); f.creds.setLicenseToken(null); f.gh(123, false);
  await f.refreshLicense();
  terminal(f, "gh_unauthenticated");
  const calls = f.trace.length;
  f.advance(120000); await f.refreshLicense();
  assert.equal(f.trace.length, calls, "terminal state stops retries");
};
cases["exponential-backoff-cap-and-terminal"] = async f => {
  f.expire(); f.gh(123, false);
  f.refresh(() => f.response(503, {}));
  for (const delay of [120000, 240000, 480000, 960000, 1800000]) {
    await f.refreshLicense();
    assert.equal(f.status()?.next_retry_at, f.now() + delay, "persist exponential retry time");
    const calls = f.trace.length;
    f.advance(delay - 1); await f.refreshLicense();
    assert.equal(f.trace.length, calls, "no retries during backoff");
    f.advance(1);
  }
  await f.refreshLicense(); terminal(f, "backoff_exhausted");
  const calls = f.trace.length;
  f.advance(1800000); await f.refreshLicense();
  assert.equal(f.trace.length, calls, "backoff cap stops retries for the session");
};
cases["success-resets-refresh-backoff"] = async f => {
  f.expire(); f.gh(123, false); f.refresh(() => f.response(503, {}));
  await f.refreshLicense();
  assert.ok(f.status()?.next_retry_at > f.now(), "persist failure backoff before testing successful recovery");
  f.advance(f.status().next_retry_at - f.now());
  f.refresh(() => f.response(200, {token:f.token()}));
  await f.refreshLicense();
  assert.equal(f.status()?.consecutive_failures, 0);
  assert.equal(f.status()?.next_retry_at, null);
  assert.equal(f.status()?.terminal, null);
};
module.exports = cases;

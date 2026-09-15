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
cases["refresh-result-after-signout-is-discarded"] = async f => {
  const event = f.event(), chunk = f.chunk(); f.expire();
  f.refresh(() => {f.creds.signOut(); return f.response(200,{token:f.token()});});
  await f.refreshLicense();
  assert.equal(f.creds.getLicenseToken(),null); purged(event); purged(chunk);
};
for (const code of [200,402]) {
  cases[`late-refresh-${code}-cannot-replace-new-signin`] = async f => {
    f.expire();
    const next = f.token({github_id:456});
    f.refresh(() => {
      f.creds.signOut(); f.creds.markEngaged();
      f.creds.commitSignin({jwt:next,orgs:["synthetic"]});
      return f.response(code,{token:f.token()});
    });
    await f.refreshLicense();
    assert.equal(f.creds.getLicenseToken(),next);
    assert.equal(f.status()?.terminal,null);
  };
}
cases["session-start-migrates-marker-and-resets-terminal"] = async f => {
  f.expire(); f.gh(123,false); f.refresh(() => f.response(410,{}));
  await f.refreshLicense(); terminal(f,"gh_unauthenticated");
  f.refresh(() => f.response(200,{token:f.token()}));
  await require("../../scripts/session_start").prepareSession();
  assert.equal(f.status()?.terminal,null);
  assert.equal(f.creds.recoverySnapshot().marker.github_id,123);
};
cases["explicit-signin-resets-terminal-and-replaces-marker"] = async f => {
  f.rememberSignin(); f.creds.setLicenseToken(null); f.gh(456);
  await f.refreshLicense(); terminal(f,"identity_mismatch");
  f.creds.markEngaged();
  const next = f.token({github_id:456});
  assert.equal(f.creds.commitSignin({jwt:next,orgs:["synthetic"]}),true);
  assert.equal(f.creds.recoverySnapshot().marker.github_id,456);
  assert.equal(f.status()?.terminal,null);
};
cases["explicit-gh-activation-402-purges-without-device-flow"] = async f => {
  const event = f.event(), chunk = f.chunk();
  f.creds.markEngaged(); f.activate(() => f.response(402,{}));
  await assert.rejects(require("../../scripts/lib/license-activation").trySilentGhActivate("SYNTHETIC",{interactive:true}),/No active SkillMeter license/);
  purged(event); purged(chunk); terminal(f,"revoked");
};
cases["old-explicit-signin-generation-cannot-commit"] = async f => {
  f.creds.markEngaged(); const generation = f.creds.recoverySnapshot().generation;
  f.creds.signOut(); f.creds.markEngaged();
  const next = f.token({github_id:456});
  f.creds.commitSignin({jwt:next,orgs:["synthetic"]});
  assert.equal(f.creds.commitSignin({jwt:f.token(),orgs:["synthetic"],expectedGeneration:generation}),false);
  assert.equal(f.creds.getLicenseToken(),next);
};
cases["logout-retirement-survives-baseline-reset"] = async f => {
  const old = f.chunk(); retained(old);
  f.creds.signOut(); f.creds.markEngaged(); f.rememberSignin();
  const next = f.chunk(); retained(next); purged(old);
  const rows = require("node:zlib").gunzipSync(fs.readFileSync(next)).toString().trim().split("\n");
  assert.equal(rows.length,1,"only the newly authored record can be reconstructed");
};
cases["expired-chunk-is-not-reconstructed-by-new-capture"] = async f => {
  const old = f.chunk(); retained(old);
  f.advance(8*86400000); f.logger.cleanupStaleFiles(); purged(old);
  f.creds.setLicenseToken(f.token());
  const next = f.chunk(); retained(next);
  const rows = require("node:zlib").gunzipSync(fs.readFileSync(next)).toString().trim().split("\n");
  assert.equal(rows.length,1,"retirement permanently excludes the old raw prefix");
};
cases["mixed-age-event-log-preserves-recent-records"] = async f => {
  const scope = f.logger.transcriptScope(f.repo);
  f.logger.logInfo("UserPromptSubmit","synthetic-session",{prompt:"old"},"SYNTHETIC",scope);
  f.advance(8*86400000); f.creds.setLicenseToken(f.token());
  f.logger.logInfo("UserPromptSubmit","synthetic-session",{prompt:"recent"},"SYNTHETIC",scope);
  f.logger.cleanupStaleFiles();
  const file = f.logger.sealEventLog(f.repo); retained(file);
  const rows = fs.readFileSync(file,"utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.map(r => r.data.prompt),["recent"]);
};
cases["purge-busy-chunk-retries-durably"] = async f => {
  const file = f.chunk(); retained(file);
  const dir = f.chunks.queueDirectories(f.logger.TRANSCRIPT_CHUNKS_DIR)[0];
  const release = f.chunks.acquireLock(require("node:path").join(dir,"lock"));
  assert.ok(release);
  f.creds.signOut(); retained(file);
  release();
  f.logger.cleanupStaleFiles(); purged(file);
  f.creds.markEngaged(); f.rememberSignin();
  const next = f.chunk(); retained(next);
  assert.equal(require("node:zlib").gunzipSync(fs.readFileSync(next)).toString().trim().split("\n").length,1);
};
cases["retire-published-chunk-without-cursor"] = async f => {
  const file = f.chunk(); retained(file);
  const dir = f.chunks.queueDirectories(f.logger.TRANSCRIPT_CHUNKS_DIR)[0];
  fs.unlinkSync(require("node:path").join(dir,"cursor.json"));
  f.creds.signOut(); purged(file);
  f.creds.markEngaged(); f.rememberSignin();
  const next = f.chunk(); retained(next);
  assert.equal(require("node:zlib").gunzipSync(fs.readFileSync(next)).toString().trim().split("\n").length,1);
};
cases["status-notice-explains-terminal-action-without-credentials"] = async f => {
  f.creds.setLicenseToken(null);
  await f.refreshLicense();
  const text = require("../../scripts/lib/lifecycle-notice").notice();
  assert.match(text,/sign-in/);
  assert.equal(text.includes("synthetic-gh-credential"),false);
};
cases["one-shot-drain-refreshes-before-delivery"] = async f => {
  const event = f.event(), chunk = f.chunk(); f.expire();
  f.delivery(() => f.response(200,{}));
  await require("../../scripts/drain_once").main();
  assert.equal(f.trace[0],"/refresh"); purged(event); purged(chunk);
};
cases["successful-short-token-obeys-refresh-cooldown"] = async f => {
  f.expire();
  f.refresh(() => f.response(200,{token:f.token({exp:Math.floor(f.now()/1000)+120})}));
  await f.refreshLicense(); await f.refreshLicense();
  assert.deepEqual(f.trace,["/refresh"]);
  f.advance(60000); await f.refreshLicense();
  assert.deepEqual(f.trace,["/refresh","/refresh"]);
};
cases["invalid-retirement-journal-blocks-source-and-delivery"] = async f => {
  const file = f.chunk(); retained(file);
  const dir = f.chunks.queueDirectories(f.logger.TRANSCRIPT_CHUNKS_DIR)[0];
  fs.writeFileSync(require("node:path").join(dir,"retired.json"),JSON.stringify({through:"invalid"}));
  assert.equal(f.chunk(),null);
  await f.logger.drainPendingTranscripts();
  assert.deepEqual(f.trace,[]); retained(file);
};
cases["signout-removes-legacy-pending-and-poison"] = async f => {
  const p = require("node:path");
  const files = [p.join(f.logger.TRANSCRIPTS_PENDING_DIR,"legacy.jsonl"),p.join(f.logger.POISON_DIR,"legacy.jsonl")];
  for (const file of files) {fs.mkdirSync(p.dirname(file),{recursive:true}); fs.writeFileSync(file,"synthetic legacy");}
  f.creds.signOut(); files.forEach(purged);
};
cases["purge-crash-keeps-retirement-and-resumes-before-new-capture"] = async f => {
  const file = f.chunk(); retained(file);
  const dir = f.chunks.queueDirectories(f.logger.TRANSCRIPT_CHUNKS_DIR)[0];
  const original = fs.rmSync;
  fs.rmSync = (target,...args) => {
    if (String(target).includes("batch-")) throw Error("synthetic deletion failure");
    return original(target,...args);
  };
  try { assert.throws(() => f.creds.signOut(),/synthetic deletion failure/); }
  finally {fs.rmSync = original;}
  retained(file);
  assert.ok(f.chunks.readRetirement(dir));
  f.creds.markEngaged(); f.rememberSignin(); purged(file);
  const next = f.chunk(); retained(next);
  assert.equal(require("node:zlib").gunzipSync(fs.readFileSync(next)).toString().trim().split("\n").length,1);
};
cases["malformed-issued-token-is-transient-and-keeps-queue"] = async f => {
  const file = f.chunk(); f.expire(); const original = f.creds.getLicenseToken();
  f.refresh(() => f.response(200,{token:"invalid synthetic token"}));
  await f.refreshLicense();
  assert.equal(f.creds.getLicenseToken(),original); retained(file);
  assert.deepEqual(f.trace,["/refresh"]);
  assert.ok(f.status()?.next_retry_at > f.now());
};
cases["old-device-flow-cannot-exchange-or-commit"] = async f => {
  f.creds.markEngaged(); const expectedGeneration = f.creds.recoverySnapshot().generation;
  f.creds.signOut(); f.creds.markEngaged(); f.rememberSignin();
  const signin = require("../../scripts/signin"), token = f.creds.getLicenseToken();
  await assert.rejects(signin.exchangeForLicense("synthetic-gh","SYNTHETIC",expectedGeneration),/superseded/);
  assert.equal(signin.scopeAndCommit(f.token({github_id:456}),["synthetic"],[],{expectedGeneration,sayFn:()=>{}}).committed,false);
  assert.equal(f.creds.getLicenseToken(),token);
  assert.deepEqual(f.trace,[]);
};
cases["late-device-activation-402-preserves-new-signin"] = async f => {
  f.creds.markEngaged(); const expectedGeneration = f.creds.recoverySnapshot().generation;
  const next = f.token({github_id:456});
  f.activate(() => {
    f.creds.signOut(); f.creds.markEngaged(); f.creds.commitSignin({jwt:next,orgs:["synthetic"]});
    return f.response(402,{});
  });
  await assert.rejects(require("../../scripts/signin").exchangeForLicense("synthetic-gh","SYNTHETIC",expectedGeneration),/No active SkillMeter license/);
  assert.equal(f.creds.getLicenseToken(),next);
  assert.equal(f.status()?.terminal,null);
};
module.exports = cases;

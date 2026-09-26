"use strict";

// Actual Claude writer -> Codex runtime, with synthetic credentials, policy,
// transcripts and intercepted delivery. No installed state or service is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fixture } = require("../../../test-support/shared-policy.cjs");
const claudeRoot = process.argv[2] && path.resolve(process.argv[2]);
if (!claudeRoot) throw new Error("Usage: node check_shared_policy_runtime.cjs /path/to/v2-claude-checkout");
const bootstrap = path.join(claudeRoot, "skillmeter/testing/bootstrap.js");
const modulePath = path.join(claudeRoot, "skillmeter/scripts/lib/telemetry-store.js");
assert.ok(fs.existsSync(bootstrap) && fs.existsSync(modulePath));
const cleanup = [];
try {
  const f = fixture({ after: fn => cleanup.push(fn) });
  f.run(`
    const claude = code => {
      const result = require('node:child_process').spawnSync(process.execPath, ['-e',
        'require(' + ${JSON.stringify(JSON.stringify(bootstrap))} + ');' +
        'process.env.CLAUDE_PLUGIN_DATA = ' + JSON.stringify(path.join(process.env.HOME, 'claude-data')) + ';' +
        'const store = require(' + ${JSON.stringify(JSON.stringify(modulePath))} + ');' + code
      ], { cwd: repo, env: {...process.env, SKILLMETER_DISABLE_KEYCHAIN:'1'}, encoding:'utf8', timeout:10000 });
      assert.equal(result.status,0,result.stderr || result.error?.message);
    };
    fs.unlinkSync(path.join(repo,'.codex/settings.local.json'));
    writePolicy(policy);
    assert.notEqual(logger.getTelemetryOptIn(repo),true,'legacy ON does not authorize a new client');
    claude('store.acknowledgeConsentStatement(1);');
    assert.equal(logger.getTelemetryOptIn(repo),true,'actual acknowledgement grants Codex permission');
    fs.writeFileSync(source,''); logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('acknowledged capture')); const first=stage(); assert.ok(first);

    logger.saveTelemetryOptIn(repo,false);
    assert.equal(logger.getTelemetryOptIn(repo),false,'local OFF still restricts shared ON');
    fs.unlinkSync(path.join(repo,'.codex/settings.local.json'));
    logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('pending before revoke')); const pending=stage(); assert.ok(pending);
    claude("store.setRepositoryOverride('github.com/acme/widgets', false);");
    await logger.drainPendingTranscripts('https://collector.invalid',1000);
    assert.equal(fs.existsSync(pending),false,'actual Claude OFF purges Codex backlog');
    assert.equal(logger.getTelemetryOptIn(repo),false);

    claude("store.setRepositoryOverride('github.com/acme/widgets', true);");
    assert.equal(logger.getTelemetryOptIn(repo),true);
    logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('before pause')); const beforePause=stage(); assert.ok(beforePause);
    const queuedBytes=fs.readFileSync(beforePause);
    claude('store.setGlobalEnabled(false);');
    logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('excluded paused text')); assert.equal(stage(),null);
    await logger.drainPendingTranscripts('https://collector.invalid',1000);
    assert.deepEqual(fs.readFileSync(beforePause),queuedBytes);
    claude('store.setGlobalEnabled(true);');
    logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('after pause')); assert.ok(stage());
    const received=[];
    global.fetch=async(_,options)=>{received.push(...require('node:zlib').gunzipSync(options.body).toString().trim().split('\\n').map(JSON.parse));return {ok:true};};
    await logger.drainPendingTranscripts('https://collector.invalid',1000);
    assert.deepEqual(received.filter(r=>r.type==='response_item').map(r=>r.payload.content),['before pause','after pause']);

    const valid=fs.readFileSync(policyFile);
    const malformed={...JSON.parse(valid),global:null}; writePolicy(malformed);
    const invalidBytes=fs.readFileSync(policyFile);
    assert.notEqual(logger.getTelemetryOptIn(repo),true,'malformed structure holds capture');
    assert.deepEqual(fs.readFileSync(policyFile),invalidBytes,'reader preserves malformed bytes');
    fs.writeFileSync(policyFile,valid);
    assert.equal(logger.getTelemetryOptIn(repo),true);
  `);
  process.stdout.write("PASS: actual Claude acknowledgement, shared capture, local OFF, queued revocation, pause retention and interval exclusion, malformed-policy hold\n");
} finally {
  cleanup.reverse().forEach(fn => fn());
}

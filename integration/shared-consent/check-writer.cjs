"use strict";
// Actual pinned writer, synthetic Codex queues, intercepted transport.
const assert = require("node:assert/strict"), path = require("node:path");
const [codexRoot, claudeRoot, contract] = process.argv.slice(2);
assert.ok(codexRoot && claudeRoot && ["legacy", "counters"].includes(contract), "Specify both checkouts and the writer contract");
const { fixture } = require(path.join(path.resolve(codexRoot), "test-support/shared-policy.cjs"));
const bootstrap = path.join(path.resolve(claudeRoot), "testing/bootstrap.js");
const store = path.join(path.resolve(claudeRoot), "skillmeter/scripts/lib/telemetry-store.js");
for (const scope of ["organization", "repository"]) {
  const cleanup = [];
  try {
    fixture({ after: fn => cleanup.push(fn) }).run(`
      const claude = code => {
        const r = require('node:child_process').spawnSync(process.execPath, ['-e',
          'require('+${JSON.stringify(JSON.stringify(bootstrap))}+');const store=require('+${JSON.stringify(JSON.stringify(store))}+');'+code], {
          cwd:repo, encoding:'utf8', timeout:10000, env:{...process.env,
            CLAUDE_PLUGIN_DATA:path.join(process.env.HOME,'claude-data'),SKILLMETER_DISABLE_KEYCHAIN:'1'} });
        assert.equal(r.status,0,r.stderr || r.error?.message);
      };
      claude("store.setOrganizationConsent('acme',true);store.setRepositoryOverride('github.com/acme/widgets',true);");
      const before=JSON.parse(fs.readFileSync(policyFile));
      const counts=p=>[p.organizations.acme.revocations,p.repositories['github.com/acme/widgets'].revocations];
      assert.deepEqual(counts(before),${contract === "counters" ? "[0,0]" : "[undefined,undefined]"},'wrong writer contract');
      const capture=()=>{
        logger.observeTranscriptConsent(source,repo);fs.appendFileSync(source,line('synthetic eligible'));
        const chunk=stage();assert.ok(chunk);
        logger.logInfo('Stop','synthetic',{cwd:logger.hashHmac(repo,'fixture-salt'),repo_root:logger.hashHmac(repo,'fixture-salt')},'SYNTHETIC');
        const event=logger.sealEventLog();assert.ok(event);return {chunk,event};
      };
      fs.writeFileSync(source,'');const queued=capture();
      const bytes=[queued.chunk,queued.event].map(file=>fs.readFileSync(file));
      const cursor=path.join(path.dirname(path.dirname(queued.chunk)),'cursor.json');const cursorBytes=fs.readFileSync(cursor);
      // No Codex observation occurs between the two actual writer calls.
      claude(${JSON.stringify(scope === "organization" ? "store.setOrganizationConsent('acme',false);store.setOrganizationConsent('acme',true);" : "store.setRepositoryOverride('github.com/acme/widgets',false);store.setRepositoryOverride('github.com/acme/widgets',true);")});
      const after=JSON.parse(fs.readFileSync(policyFile));
      assert.deepEqual(counts(after),${contract === "counters" ? (scope === "organization" ? "[1,0]" : "[0,1]") : "[undefined,undefined]"});
      let calls=0;global.fetch=async()=>{calls++;return {ok:true,status:200};};
      await logger.processPendingTranscript(queued.chunk,'SYNTHETIC','https://collector.invalid',1000);
      await logger.processSealedBatch(queued.event,'https://collector.invalid',1000);
      assert.equal(calls,0,'old payload must not reach transport');
      ${contract === "counters" ? "assert.equal(fs.existsSync(queued.chunk),false);assert.equal(fs.existsSync(queued.event),false);" : "[queued.chunk,queued.event].forEach((file,i)=>assert.deepEqual(fs.readFileSync(file),bytes[i]));"}
      assert.deepEqual(fs.readFileSync(cursor),cursorBytes,'consent disposition preserves the cursor');
      const fresh=capture();
      await logger.processPendingTranscript(fresh.chunk,'SYNTHETIC','https://collector.invalid',1000);
      await logger.processSealedBatch(fresh.event,'https://collector.invalid',1000);
      assert.equal(calls,2,'fresh authorized capture still delivers');
    `);
  } finally { cleanup.reverse().forEach(fn => fn()); }
}
console.log("PASS: actual writer OFF/ON in both scopes, old-payload disposition, cursor preservation and fresh delivery");

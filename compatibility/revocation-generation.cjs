"use strict";
// Proposed shared-consent counter contract acceptance cases. Run explicitly with:
// node --test compatibility/revocation-generation.cjs
// Absent counters mean zero; higher counters purge, equal deliver, lower hold.
// These expose gaps in the timestamp-based reader and writer; they are not
// included in the passing default suite until the shared contract is implemented.
const { test } = require("node:test");
const { fixture } = require("../test-support/shared-policy.cjs");

const setup = `
  const withCounters = value => ({ ...value,
    organizations: {acme:{...value.organizations.acme,revocations:0}},
    repositories: {'github.com/acme/widgets':{...value.repositories['github.com/acme/widgets'],revocations:0}},
  });
  const initial = withCounters(policy);
  fs.writeFileSync(source,'');
  const capture = () => {
    logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('previously authorized'));
    const chunk=stage(); assert.ok(chunk);
    logger.logInfo('Stop','synthetic',{cwd:logger.hashHmac(repo,'fixture-salt'),repo_root:logger.hashHmac(repo,'fixture-salt')},'SYNTHETIC');
    const event=logger.sealEventLog(); assert.ok(event);
    return {chunk,event};
  };
  let calls=0;
  global.fetch=async()=>{calls++;return {ok:true,status:200};};
  const deliver = async queued => {
    await logger.processPendingTranscript(queued.chunk,'SYNTHETIC','https://collector.invalid',1000);
    await logger.processSealedBatch(queued.event,'https://collector.invalid',1000);
  };
`;

test("first zero-generation shared adoption delivers already stamped local queues", t => {
  fixture(t).run(setup + `
    const queued=capture(); // Released-format routing exists before a policy.
    writePolicy(initial);
    await deliver(queued);
    assert.equal(calls,2,'one transcript and one event request');
    assert.equal(fs.existsSync(queued.chunk),false);
  `);
});

for (const scope of ["organizations", "repositories"]) {
  const key = scope === "organizations" ? "acme" : "github.com/acme/widgets";
  test(`${scope}: unchanged policy delivers both queues (positive control)`, t => {
    fixture(t).run(setup + `
      initial.${scope}['${key}'].revocations=2;
      writePolicy(initial); const queued=capture();
      await deliver(queued);
      assert.equal(calls,2);
      assert.equal(fs.existsSync(queued.chunk),false);
      assert.equal(fs.existsSync(queued.event),false);
    `);
  });
  test(`${scope}: equal revocations permits timestamp reaffirmation`, t => {
    fixture(t).run(setup + `
      writePolicy(initial); const queued=capture();
      writePolicy({...initial,revision:2,${scope}:{'${key}':{...initial.${scope}['${key}'],decided_at:2}}});
      await deliver(queued);
      assert.equal(calls,2);
    `);
  });
  test(`${scope}: an unseen OFF/ON counter increase purges both queues`, t => {
    fixture(t).run(setup + `
      writePolicy(initial); const queued=capture();
      // The current choice and timestamp alone cannot reveal the intervening OFF.
      writePolicy({...initial,revision:2,${scope}:{'${key}':{...initial.${scope}['${key}'],revocations:1}}});
      await logger.drainQueuesOnce('https://collector.invalid',1000);
      assert.equal(calls,0,'revoked data must not reach transport');
      assert.equal(fs.existsSync(queued.chunk),false,'revoked transcript removed');
      assert.equal(fs.existsSync(queued.event),false,'revoked events removed');
    `);
  });

  test(`${scope}: an absent legacy counter equals explicit zero`, t => {
    fixture(t).run(setup + `
      const legacy=structuredClone(initial); delete legacy.${scope}['${key}'].revocations;
      writePolicy(legacy); const queued=capture();
      writePolicy({...initial,revision:2,${scope}:{'${key}':{...initial.${scope}['${key}'],decided_at:2}}});
      await deliver(queued);
      assert.equal(calls,2,'legacy zero survives an ON reaffirmation');
    `);
  });

  test(`${scope}: a lower counter holds both queues until it catches up`, t => {
    fixture(t).run(setup + `
      const captured=structuredClone(initial); captured.${scope}['${key}'].revocations=2;
      writePolicy(captured); const queued=capture();
      const before=[queued.chunk,queued.event].map(file=>fs.readFileSync(file));
      const lower=structuredClone(captured); lower.revision=2; lower.${scope}['${key}'].revocations=1;
      writePolicy(lower); await deliver(queued);
      assert.equal(calls,0,'rollback must not authorize delivery');
      [queued.chunk,queued.event].forEach((file,i)=>assert.deepEqual(fs.readFileSync(file),before[i],'hold preserves payload bytes'));
      writePolicy({...captured,revision:3}); await deliver(queued);
      assert.equal(calls,2,'catch-up permits the retained data');
    `);
  });

  for (const invalid of [-1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
    test(`${scope}: malformed counter ${JSON.stringify(invalid)} holds queued data`, t => {
      fixture(t).run(setup + `
        writePolicy(initial); const queued=capture();
        const before=[queued.chunk,queued.event].map(file=>fs.readFileSync(file));
        const invalid=structuredClone(initial); invalid.revision=2; invalid.${scope}['${key}'].revocations=${JSON.stringify(invalid)};
        writePolicy(invalid); await deliver(queued);
        assert.equal(calls,0,'invalid counter must not reach transport');
        [queued.chunk,queued.event].forEach((file,i)=>assert.deepEqual(fs.readFileSync(file),before[i],'invalid policy retains queued bytes'));
      `);
    });
  }
}

for (const enabled of [false, true]) {
  test(`repository writer ${enabled ? 'ON preserves' : 'OFF increments'} its counter`, t => {
    fixture(t).run(setup + `
      initial.repositories['github.com/acme/widgets'].revocations=4;
      writePolicy(initial);
      const {createSharedPolicyStore}=require(path.join(process.env.PLUGIN_ROOT,'scripts/lib/shared-policy-store.js'));
      const store=createSharedPolicyStore({file:policyFile,observedFile:path.join(process.env.PLUGIN_DATA,'counter-observed')});
      store.setRepositoryOverride('github.com/acme/widgets',${enabled},{expectedRevision:1,acknowledged:true});
      const saved=JSON.parse(fs.readFileSync(policyFile,'utf8'));
      assert.equal(saved.repositories['github.com/acme/widgets'].revocations,${enabled ? 4 : 5});
      assert.equal(saved.organizations.acme.revocations,0,'unrelated counter preserved');
    `);
  });
}

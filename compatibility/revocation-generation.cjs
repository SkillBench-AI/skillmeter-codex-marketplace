"use strict";
// Pending contract acceptance cases. Run explicitly with:
// node --test compatibility/revocation-generation.cjs
// These expose gaps in the released timestamp-based reader; they are not
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
}

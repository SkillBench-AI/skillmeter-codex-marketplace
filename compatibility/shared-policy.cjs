"use strict";
// Explicit contract audit, outside the default test suite. Nonzero means the
// remaining Claude repository/organization contract is not implemented yet.
const { test } = require("node:test");
const { fixture } = require("../test-support/shared-policy.cjs");

for (const scope of ["organizations", "repositories"]) {
  const key = scope === "organizations" ? "acme" : "github.com/acme/widgets";
  test(`shared ${scope} OFF prevents capture in a locally enabled checkout`, t => {
    fixture(t).run(`
      writePolicy({...policy,${scope}:{'${key}':{enabled:false}}});
      fs.writeFileSync(source,''); logger.observeTranscriptConsent(source,repo);
      fs.appendFileSync(source,line('must not capture'));
      assert.equal(stage(),null);
    `);
  });
}

for (const kind of ["clone", "worktree"]) {
  test(`shared repository opt-out applies to a second ${kind}`, t => {
    fixture(t).run(`
      const second=path.join(path.dirname(repo),'${kind}'); fs.mkdirSync(second);
      if ('${kind}' === 'clone') {
        fs.mkdirSync(path.join(second,'.git')); fs.copyFileSync(path.join(repo,'.git/config'),path.join(second,'.git/config'));
      } else {
        const gitdir=path.join(repo,'.git/worktrees/second'); fs.mkdirSync(gitdir,{recursive:true});
        fs.writeFileSync(path.join(gitdir,'commondir'),'../..');
        fs.writeFileSync(path.join(second,'.git'),'gitdir: '+gitdir+'\\n');
      }
      logger.saveTelemetryOptIn(second,true);
      writePolicy({...policy,repositories:{'github.com/acme/widgets':{enabled:false}}});
      fs.writeFileSync(source,''); logger.observeTranscriptConsent(source,second);
      fs.appendFileSync(source,line('revoked in all checkouts'));
      assert.equal(logger.stageTranscriptForUpload(source,{cwd:second}),null);
    `);
  });
}

test("shared repository OFF purges already queued repository payloads", t => {
  fixture(t).run(`
    writePolicy(policy); fs.writeFileSync(source,''); logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('formerly authorized')); const chunk=stage(); assert.ok(chunk);
    writePolicy({...policy,revision:2,repositories:{'github.com/acme/widgets':{enabled:false}}});
    // A blocked request alone is insufficient: the canonical contract deletes
    // queued payloads after revocation. Never acknowledge a fake upload here.
    global.fetch=async()=>({ok:false,status:503});
    await logger.processPendingTranscript(chunk,'SYNTHETIC','https://collector.invalid',1000);
    assert.equal(fs.existsSync(chunk),false);
  `);
});

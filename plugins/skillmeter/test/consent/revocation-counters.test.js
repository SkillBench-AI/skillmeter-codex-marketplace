"use strict";
const { test } = require("node:test");
const { fixture } = require("../../../../test-support/shared-policy.cjs");

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
    const queued=capture(); // This client observed zero counters before a policy existed.
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

  test(`${scope}: legacy queues stay held when counters are first introduced`, t => {
    fixture(t).run(setup + `
      const legacy=structuredClone(initial); delete legacy.${scope}['${key}'].revocations;
      writePolicy(legacy); const queued=capture();
      writePolicy({...initial,revision:2,${scope}:{'${key}':{...initial.${scope}['${key}'],decided_at:2}}});
      await deliver(queued);
      assert.equal(calls,0,'missing counters do not prove an unchanged revocation history');
      assert.ok(fs.existsSync(queued.chunk));assert.ok(fs.existsSync(queued.event));
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

for (const missingScope of ['organizations', 'repositories', 'both']) {
  for (const changedScope of ['organizations', 'repositories']) {
    test(`legacy ${missingScope} counters: unseen ${changedScope} OFF/ON holds old queues`, t => {
      fixture(t).run(setup + `
        const legacy=structuredClone(initial);
        if ('${missingScope}' !== 'repositories') delete legacy.organizations.acme.revocations;
        if ('${missingScope}' !== 'organizations') delete legacy.repositories['github.com/acme/widgets'].revocations;
        writePolicy(legacy);const old=capture();
        const before=[old.chunk,old.event].map(file=>fs.readFileSync(file));
        // Released writers leave only the final timestamp when Codex missed OFF.
        const key='${changedScope}'==='organizations'?'acme':'github.com/acme/widgets';
        legacy.${changedScope}[key].decided_at=2;legacy.revision=3;writePolicy(legacy);
        await deliver(old);assert.equal(calls,0,'no transport for ambiguous pre-OFF data');
        [old.chunk,old.event].forEach((file,i)=>assert.deepEqual(fs.readFileSync(file),before[i]));
        const fresh=capture();await deliver(fresh);assert.equal(calls,2,'new authorized data can deliver');
        await deliver(old);assert.equal(calls,2,'new capture must not release old queues');
      `);
    });
  }
}

test('unchanged legacy policy delivers released-client queues across upgrade and restart', t => {
  const f=fixture(t);
  f.run(setup + `
    writePolicy(policy);const queued=capture();
    // Released routing indexes have no counter observations or writer-mode flag.
    const routingFile=path.join(logger.LOG_DIR,'repository-routing',logger.hashHmac(repo,'fixture-salt')+'.json');
    const routing=JSON.parse(fs.readFileSync(routingFile));
    delete routing.revocationsSeen;delete routing.sharedCountersExplicit;
    fs.writeFileSync(routingFile,JSON.stringify(routing));
    fs.writeFileSync(source+'.queued',JSON.stringify(queued));
  `);
  f.run(setup + `
    await deliver(JSON.parse(fs.readFileSync(source+'.queued')));assert.equal(calls,2);
  `);
});

test('a legacy writer between counter-aware observations cannot release its old queue on upgrade', t => {
  fixture(t).run(setup + `
    writePolicy(initial);const first=capture();
    const legacy=structuredClone(initial);delete legacy.repositories['github.com/acme/widgets'].revocations;
    writePolicy(legacy);await deliver(first);assert.equal(calls,0,'losing counters preserves a hold even with the same timestamp');
    const old=capture();
    initial.repositories['github.com/acme/widgets'].decided_at=3;writePolicy(initial);
    await deliver(old);assert.equal(calls,0,'restored zero cannot prove absence of an intervening legacy OFF');
    assert.ok(fs.existsSync(old.chunk));assert.ok(fs.existsSync(old.event));
    const fresh=capture();await deliver(fresh);assert.equal(calls,2);
  `);
});

test('a legacy timestamp hold survives restart and returning to the original timestamp', t => {
  const f=fixture(t);
  f.run(setup + `
    writePolicy(policy);const queued=capture();fs.writeFileSync(source+'.queued',JSON.stringify(queued));
    policy.repositories['github.com/acme/widgets'].decided_at=2;writePolicy(policy);
    await deliver(queued);assert.equal(calls,0);
  `);
  f.run(setup + `
    writePolicy(policy);
    const queued=JSON.parse(fs.readFileSync(source+'.queued'));
    await deliver(queued);assert.equal(calls,0);
    assert.ok(fs.existsSync(queued.chunk));assert.ok(fs.existsSync(queued.event));
  `);
});

test('losing counter fields cannot lift an existing rollback capture hold', t => {
  fixture(t).run(setup + `
    initial.repositories['github.com/acme/widgets'].revocations=2;writePolicy(initial);capture();
    const lower=structuredClone(initial);lower.repositories['github.com/acme/widgets'].revocations=1;
    writePolicy(lower);assert.equal(logger.getTelemetryOptIn(repo),null);
    delete lower.repositories['github.com/acme/widgets'].revocations;writePolicy(lower);
    assert.equal(logger.getTelemetryOptIn(repo),null,'missing counters cannot prove catch-up');
    writePolicy(initial);assert.equal(logger.getTelemetryOptIn(repo),true);
  `);
});

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

for (const missingOther of [false, true]) {
  test(`explicit OFF without a counter increase purges while paused (missing other choice: ${missingOther})`, t => {
    fixture(t).run(setup + `
      writePolicy(initial); const queued=capture();
      const off=structuredClone(initial); off.global.enabled=false;
      off.repositories['github.com/acme/widgets'].enabled=false;
      if (${missingOther}) off.organizations={};
      writePolicy(off); await logger.drainQueuesOnce('https://collector.invalid',1000);
      assert.equal(calls,0);
      assert.equal(fs.existsSync(queued.chunk),false);
      assert.equal(fs.existsSync(queued.event),false);
    `);
  });
}

test('upgrade holds an existing random-token queue until an explicit OFF', t => {
  fixture(t).run(setup + `
    writePolicy(initial); const queued=capture();
    const routingFile=path.join(logger.LOG_DIR,'repository-routing',logger.hashHmac(repo,'fixture-salt')+'.json');
    const routing=JSON.parse(fs.readFileSync(routingFile)); delete routing.revocationsSeen;
    fs.writeFileSync(routingFile,JSON.stringify(routing));
    const before=[queued.chunk,queued.event].map(file=>fs.readFileSync(file));
    await deliver(queued); assert.equal(calls,0);
    [queued.chunk,queued.event].forEach((file,i)=>assert.deepEqual(fs.readFileSync(file),before[i]));
    initial.repositories['github.com/acme/widgets'].revocations=2;writePolicy(initial);
    await deliver(queued); assert.equal(calls,0,'unknown previous counter cannot prove a revocation');
    initial.repositories['github.com/acme/widgets'].enabled=false;writePolicy(initial);
    await logger.drainQueuesOnce('https://collector.invalid',1000);
    assert.equal(fs.existsSync(queued.chunk),false);assert.equal(fs.existsSync(queued.event),false);
  `);
});

test('counter rollback blocks capture and catch-up excludes the disabled interval', t => {
  fixture(t).run(setup + `
    initial.repositories['github.com/acme/widgets'].revocations=2;writePolicy(initial);
    capture();
    const lower=structuredClone(initial);lower.repositories['github.com/acme/widgets'].revocations=1;
    writePolicy(lower);assert.equal(logger.getTelemetryOptIn(repo),null);
    logger.observeTranscriptConsent(source,repo);fs.appendFileSync(source,line('rollback content'));assert.equal(stage(),null);
    writePolicy(initial);assert.equal(logger.getTelemetryOptIn(repo),true);
    logger.observeTranscriptConsent(source,repo);fs.appendFileSync(source,line('caught up'));
    const chunk=stage();assert.ok(chunk);
    assert.deepEqual(records([chunk]).map(r=>r.payload.content),['caught up']);
  `);
});

test('one higher and one lower counter revokes old data without forgetting the high-water mark', t => {
  fixture(t).run(setup + `
    initial.organizations.acme.revocations=2;writePolicy(initial);const queued=capture();
    const mixed=structuredClone(initial);mixed.organizations.acme.revocations=1;mixed.repositories['github.com/acme/widgets'].revocations=1;
    writePolicy(mixed);await logger.drainQueuesOnce('https://collector.invalid',1000);
    assert.equal(calls,0);assert.equal(fs.existsSync(queued.chunk),false);assert.equal(fs.existsSync(queued.event),false);
    assert.equal(logger.getTelemetryOptIn(repo),null);
    mixed.organizations.acme.revocations=2;writePolicy(mixed);
    assert.equal(logger.getTelemetryOptIn(repo),true);
    const next=capture();await deliver(next);assert.equal(calls,2);
  `);
});

test('new data can deliver after revocation while the old cursor and revoked generation stay protected', t => {
  fixture(t).run(setup + `
    writePolicy(initial);const old=capture();
    const cursor=path.join(path.dirname(path.dirname(old.chunk)),'cursor.json');const before=fs.readFileSync(cursor);
    initial.repositories['github.com/acme/widgets'].revocations=1;writePolicy(initial);
    await logger.drainQueuesOnce('https://collector.invalid',1000);
    assert.deepEqual(fs.readFileSync(cursor),before);
    const next=capture();await deliver(next);assert.equal(calls,2);
    assert.equal(fs.existsSync(old.chunk),false);assert.equal(fs.existsSync(old.event),false);
  `);
});

test('repeated OFF increments and counter overflow leaves the policy unchanged', t => {
  fixture(t).run(setup + `
    writePolicy(initial);
    const {createSharedPolicyStore}=require(path.join(process.env.PLUGIN_ROOT,'scripts/lib/shared-policy-store.js'));
    const store=createSharedPolicyStore({file:policyFile,observedFile:path.join(process.env.PLUGIN_DATA,'counter-observed')});
    store.setRepositoryOverride('github.com/acme/widgets',false,{expectedRevision:1});
    const saved=store.setRepositoryOverride('github.com/acme/widgets',false,{expectedRevision:2});
    assert.equal(saved.repositories['github.com/acme/widgets'].revocations,2);
    saved.repositories['github.com/acme/widgets'].revocations=Number.MAX_SAFE_INTEGER;writePolicy(saved);
    const before=fs.readFileSync(policyFile);
    assert.throws(()=>store.setRepositoryOverride('github.com/acme/widgets',false,{expectedRevision:3}));
    assert.deepEqual(fs.readFileSync(policyFile),before);
  `);
});

for (const invalid of [{org:0}, {org:-1,repo:0}, {org:0,repo:'0'}]) {
  test(`malformed persisted counter observation holds without overwriting routing: ${JSON.stringify(invalid)}`, t => {
    fixture(t).run(setup + `
      writePolicy(initial);const queued=capture();
      const routingFile=path.join(logger.LOG_DIR,'repository-routing',logger.hashHmac(repo,'fixture-salt')+'.json');
      const routing=JSON.parse(fs.readFileSync(routingFile));routing.revocationsSeen=${JSON.stringify(invalid)};
      fs.writeFileSync(routingFile,JSON.stringify(routing));const before=fs.readFileSync(routingFile);
      await deliver(queued);assert.equal(calls,0);
      assert.deepEqual(fs.readFileSync(routingFile),before);
      assert.ok(fs.existsSync(queued.chunk));assert.ok(fs.existsSync(queued.event));
      assert.equal(logger.getTelemetryOptIn(repo),null);
    `);
  });
}

for (const kind of ['clone','worktree']) {
  test(`unobserved counter revocation reaches an indexed ${kind}`, t => {
    fixture(t).run(setup + `
      writePolicy(initial);const first=capture();
      const second=path.join(path.dirname(repo),'${kind}');fs.mkdirSync(second);
      if ('${kind}'==='clone') {
        fs.mkdirSync(path.join(second,'.git'));fs.copyFileSync(path.join(repo,'.git/config'),path.join(second,'.git/config'));
      } else {
        const gitdir=path.join(repo,'.git/worktrees/second');fs.mkdirSync(gitdir,{recursive:true});
        fs.writeFileSync(path.join(gitdir,'commondir'),'../..');fs.writeFileSync(path.join(second,'.git'),'gitdir: '+gitdir+'\\n');
      }
      logger.saveTelemetryOptIn(second,true);
      const secondSource=source+'.second';fs.writeFileSync(secondSource,'');logger.observeTranscriptConsent(secondSource,second);
      fs.appendFileSync(secondSource,line('second checkout'));
      const secondChunk=logger.stageTranscriptForUpload(secondSource,{cwd:second});assert.ok(secondChunk);
      initial.repositories['github.com/acme/widgets'].revocations=1;writePolicy(initial);
      await logger.drainQueuesOnce('https://collector.invalid',1000);
      assert.equal(calls,0);assert.equal(fs.existsSync(first.chunk),false);
      assert.equal(fs.existsSync(first.event),false);assert.equal(fs.existsSync(secondChunk),false);
    `);
  });
}

test('CLI exposes a persisted counter rollback rather than claiming capture is eligible', t => {
  const f=fixture(t);
  f.run(setup + `
    initial.organizations.acme.revocations=2;writePolicy(initial);capture();
    initial.organizations.acme.revocations=1;writePolicy(initial);
  `);
  require('node:assert/strict').match(f.cli(['status']).stderr,/shared revocation counters are older/);
});


test('an OFF with another choice missing retains the counter high-water mark', t => {
  fixture(t).run(setup + `
    initial.organizations.acme.revocations=2;writePolicy(initial);const queued=capture();
    const off=structuredClone(initial);off.organizations={};off.repositories['github.com/acme/widgets'].enabled=false;
    writePolicy(off);await logger.drainQueuesOnce('https://collector.invalid',1000);
    assert.equal(fs.existsSync(queued.chunk),false);assert.equal(fs.existsSync(queued.event),false);
    initial.organizations.acme.revocations=1;writePolicy(initial);
    assert.equal(logger.getTelemetryOptIn(repo),null,'an incomplete OFF cannot erase the earlier counter observation');
    assert.equal(calls,0);
  `);
});

for (const scope of ['org','repo']) {
  test(`${scope} counter history survives a remote switch and policy rollback`, t => {
    fixture(t).run(setup + `
      initial.repositories['github.com/acme/other']={enabled:true,revocations:0};
      if ('${scope}'==='org') initial.organizations.acme.revocations=5;
      else initial.repositories['github.com/acme/widgets'].revocations=5;
      writePolicy(initial);capture();
      const setRemote = name => fs.writeFileSync(path.join(repo,'.git/config'),'[remote "origin"]\\nurl = https://github.com/acme/'+name+'.git\\n');
      setRemote('other');
      if ('${scope}'==='org') {
        initial.organizations.acme.revocations=4;writePolicy(initial);
      } else {
        assert.equal(logger.getTelemetryOptIn(repo),true);
        setRemote('widgets');initial.repositories['github.com/acme/widgets'].revocations=4;writePolicy(initial);
      }
      assert.equal(logger.getTelemetryOptIn(repo),null,'remote switch cannot lower an observed counter');
      if ('${scope}'==='org') initial.organizations.acme.revocations=5;
      else initial.repositories['github.com/acme/widgets'].revocations=5;
      writePolicy(initial);assert.equal(logger.getTelemetryOptIn(repo),true);
    `);
  });
}

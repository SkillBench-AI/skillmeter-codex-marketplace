"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), zlib = require("node:zlib");
const { releasedCode } = require("./compatibility/released-code.cjs");
const contract = require("../../../.github/scripts/compatibility-contract.cjs").load();
const releases = contract.upgradePaths;
const candidate = require("../scripts/lib/transcript-delta");
const repository = path.resolve(__dirname, "../../..");
const scope = { owner: "fixture", deviceId: "fixture", cwd: "/synthetic", repoRoot: "/synthetic", org: "synthetic", consentStamp: "fixture-grant" };
const salt = "fixture", stamp = "fixture-settings";
const row = text => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: text } }) + "\n";
const meta = JSON.stringify({ type: "session_meta", payload: { id: "upgrade-fixture", cwd: "/synthetic", originator: "codex_cli_rs" } }) + "\n";
const messages = files => files.flatMap(file => zlib.gunzipSync(fs.readFileSync(file)).toString().trim().split("\n").map(JSON.parse))
  .filter(record => record.type === "response_item").map(record => record.payload.content);

for (const release of releases) for (const queueCase of contract.requiredCases.releasedQueue) {
  const pending = queueCase === "pending";
  test(`released ${release.version} -> candidate, ${pending ? "pending retry" : "acknowledged"} queue`, async t => {
    const previous = require(path.join(releasedCode(t, repository, release, "plugins/skillmeter"), "scripts/lib/transcript-delta"));
    assert.equal(typeof previous.observeConsent === "function", release.consentJournal);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-state-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const source = path.join(temp, "source.jsonl"), root = path.join(temp, "queue");
    fs.writeFileSync(source, "");
    if (release.consentJournal) previous.observeConsent(root, source, scope, salt, true, stamp);
    fs.appendFileSync(source, meta + row("old acknowledged work"));
    const first = previous.stage(root, source, scope, salt, release.consentJournal ? {
      consent: previous.observeConsent(root, source, scope, salt, true, stamp), preserveSessionMetadata: true,
    } : {});
    const dir = candidate.queueDirectories(root)[0];
    const firstBytes = first.files.map(file => fs.readFileSync(file));
    if (!pending) await previous.drainDirectory(dir, async () => "sent");
    fs.appendFileSync(source, row("eligible unstaged work"));
    const sourceBefore = fs.readFileSync(source);
    if (!release.consentJournal) {
      assert.throws(() => candidate.observeConsent(root, source, scope, salt, true, stamp), /legacy-consent-migration-required/);
      if (pending) assert.throws(() => candidate.prepareLegacyMigration(root, source, scope, salt), /legacy-pending-chunks/);
    }
    if (pending) {
      const attempts = [];
      await candidate.drainDirectory(dir, async (_, body) => { attempts.push(body); return "retry"; });
      assert.deepEqual(candidate.pendingFiles(dir).map(file => fs.readFileSync(file)), firstBytes);
      await candidate.drainDirectory(dir, async (_, body) => { attempts.push(body); return "sent"; });
      assert.deepEqual(attempts, [...firstBytes.slice(0, 1), ...firstBytes]);
    }
    const oldCursor = JSON.parse(fs.readFileSync(path.join(dir, "cursor.json")));
    if (!release.consentJournal) {
      const plan = candidate.prepareLegacyMigration(root, source, scope, salt);
      const options = { plan, authorizedRanges: [[0, plan.observed]], evidence: "synthetic fixture grant", stamp, authorizeCommit: () => true };
      // Published migration interrupted before cursor write must finish on reopen.
      assert.throws(() => candidate.applyLegacyMigration(root, source, scope, salt, { ...options, fault: () => { throw Error("fixture-interruption"); } }), /fixture-interruption/);
      assert.equal(candidate.applyLegacyMigration(root, source, scope, salt, options).status, "already-migrated");
    }
    const migrated = JSON.parse(fs.readFileSync(path.join(dir, "cursor.json")));
    for (const field of ["offset", "seq", "generation", "baseline", "prefix"]) assert.equal(migrated[field], oldCursor[field]);
    assert.deepEqual(fs.readFileSync(source), sourceBefore);
    fs.appendFileSync(source, row("new work") + row("new work"));
    const stage = () => candidate.stage(root, source, scope, salt, {
      consent: candidate.observeConsent(root, source, scope, salt, true, stamp), preserveSessionMetadata: true,
    });
    const next = stage();
    assert.deepEqual(messages(next.files), ["eligible unstaged work", "new work", "new work"]);
    assert.equal(next.cursor.generation, first.cursor.generation);
    assert.equal(next.cursor.baseline, first.cursor.baseline);
    assert.equal(next.cursor.seq, first.cursor.seq + next.files.length);
    assert.equal(stage().status, "unchanged");
    // A retained queue backup must reopen at the same cursor before publishing.
    const backup = path.join(temp, "queue-backup");
    fs.cpSync(root, backup, { recursive: true });
    assert.deepEqual(candidate.pendingFiles(candidate.queueDirectories(backup)[0]).map(file => fs.readFileSync(file)), next.files.map(file => fs.readFileSync(file)));
    assert.deepEqual(candidate.recover(candidate.queueDirectories(backup)[0]), next.cursor);
    await candidate.drainDirectory(dir, async () => "reset-required");
    const reset = stage();
    assert.deepEqual(messages(reset.files), ["old acknowledged work", "eligible unstaged work", "new work", "new work"]);
    assert.ok(reset.cursor.baseline > next.cursor.baseline);
  });
}

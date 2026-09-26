# Legacy consent migration

An installed 0.6.1 queue has a byte cursor but no consent journal. Creating a
fresh journal at upgrade excludes its whole source prefix, including unstaged
eligible work. The fixed client holds that queue with
`legacy-consent-migration-required` until an explicit migration is complete.
It does not infer historical permission from a currently enabled repository.

The migration command writes only local state; it never uploads. It requires the
current owner, device, repository and settings to match a bounded source/cursor
plan. It preserves the existing generation, baseline, sequence, offset and salt.
New chunks carry continuation metadata without resetting earlier stored evidence.
The durable receipt makes interrupted cursor/journal updates recoverable.

## Operator sequence

Use reviewed, compatible code. Finish active turns and stop old hooks/retry
processes before replacing the installation. Keep a protected backup of plugin
data, credentials/identity material and repository settings. Do not print those
files or put them in Git. Do not disable/re-enable consent to simulate a pause:
revocation can remove queued data and creates a different authorization boundary.

The command refuses a queue with pending chunks or a pending server reset.
Deliver still-authorized old chunks through the compatible existing runtime and
reconcile their acknowledgment first. Do not delete chunks to satisfy this check.
A changed owner requires a separate recovery decision, never an owner-field edit.

From the enabled repository, with the existing preserved `PLUGIN_DATA` directory:

```sh
node /path/to/reviewed/plugin/scripts/transcript_migrate.js prepare \
  /absolute/path/to/source.jsonl /protected/path/approval.json
```

The output file is private (0600), contains no transcript content, and begins with
`authorizedRanges: null` and `evidence: null`. Nothing is authorized automatically.
Have the responsible operator populate sorted, non-overlapping, half-open **raw
byte ranges** and a short approval/source reference. Endpoints must be complete
JSONL boundaries. Use actual evidence for historical authorization; do not set
`[0, observed]` merely because it makes recovery convenient. All omitted ranges
remain excluded. An empty list intentionally excludes the whole observed prefix.
Records appended after the observation follow ordinary current consent rules.

```sh
node /path/to/reviewed/plugin/scripts/transcript_migrate.js apply \
  /protected/path/approval.json
```

Source growth, rewrite, cursor changes, settings transitions, changed scope,
missing approval, partial records or pending uploads block application. Re-plan
and review changed ranges. Successful application does not stage or send data.
Only resume the compatible runtime after checking the receipt and retained
cursor. Do not roll back to an old writer over migrated state.

## Recovery and acceptance

If an excluded range overlaps previously acknowledged legacy bytes, future full
baseline resets stop with `legacy-reset-recovery-required`. This prevents a
consent-limited baseline from silently replacing more complete older evidence.
The operator must resolve that recovery with collector/reader semantics and
authorization evidence; the client must not broaden permission to get past it.

Where all baseline evidence is approved, missing-baseline recovery can rebuild
the generation normally. Test old prefix + migrated backlog + new work, retries,
cross-day tool linkage and reset behavior with the actual collector and reader.
Verify expected source identities and content, not just queue EOF or an HTTP 2xx.
Compaction repair is separately required for the known oversized backlog.

Run `node --test plugins/skillmeter/test/legacy-consent-migration.test.js` and the
cross-repository contract harness. Local synthetic compatibility does not establish
installed-hook, production deployment, live-model or weekly-report acceptance.

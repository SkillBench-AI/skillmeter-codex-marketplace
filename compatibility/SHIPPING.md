# Shipping gate setup

This setup covers the Codex marketplace's main branch and GitHub release
workflow. It does not configure the Claude marketplace or backend deployment
pipelines. Their independent release gates and rollout order still need adoption.
Do not call compatibility enforced until the hosted acceptance checks below pass.

## Trust and execution

Public PR checks use no private checkout credential. Their `Compatibility required`
result is queue admission only. Required merge queue processing creates the combined
candidate; `merge_group` checks test that exact commit against reviewed dependency
SHAs. Failed, skipped, cancelled, missing or mismatched evidence blocks the final
result. Standard CI also handles `merge_group` so every required check is present.

Only main dispatches and main's merge-group refs can run the reusable private job.
It checks environment protections before requesting approval, then reads
`COMPATIBILITY_READ_TOKEN` from the fixed `compatibility-reviewed` environment.
Checkout credentials are not persisted. Test code remains capable of reading
private checkout contents, so the environment reviewer must review the entire
candidate, workflow changes and dependency pins before approving it. Fork PRs
must receive that review too. Never approve by job title alone.

Release dispatch tests main again. A separate protected environment supplies a
publisher App key only after compatibility succeeds. The default workflow token
has contents-read permission. The publisher token is limited to contents-write
for this repository and revoked after the job. Evidence older than one hour, a changed main or a conflicting tag
holds publication. Tag rules prevent concurrent retargeting; the archive always
comes from the tested commit, even if main advances immediately after the last
check. GitHub does not offer an atomic main-check-and-release operation.

Reviewers and administrators are trusted. Required checks cannot protect against
someone deliberately approving a replacement workflow that fabricates its own
result, or an administrator weakening repository settings. Protect workflow,
harness, contract and pin changes through designated engineering review. Restrict
who can edit releases and environment settings. Tag rules protect Git refs; they
do not make release descriptions or uploaded assets immutable.

## Administrator setup

Select responsible reviewers and adopt the supported matrix before activation.
Keep existing PR review, force-push and deletion protections. Inspect both
rulesets and classic branch protection; a 404 from the latter is not evidence
that the repository is unprotected.

Create these environments with required reviewers, **prevent self-review**, and
**administrator bypass disabled**. Use custom deployment policies of type
`branch`, exactly as listed. The preflight rejects missing or broader policies.

| Environment | Allowed branches | Protected configuration |
| --- | --- | --- |
| `compatibility-reviewed` | `main`, `gh-readonly-queue/main/*` | Secret `COMPATIBILITY_READ_TOKEN`, contents-read only for the collector and pipeline repositories |
| `release-publisher` | `main` | Variable `RELEASE_APP_ID`; secret `RELEASE_APP_PRIVATE_KEY` for a dedicated publisher App |

Install the publisher App only on this marketplace, with contents-write and no
administration permission. Do not reuse GitHub Actions' shared App identity as the
tag-creation bypass. Do not store either credential as a repository-wide secret
or reuse a developer credential. No private token belongs in a PR job.

Render the additive rulesets with the publisher's numeric **App ID** (not its
installation or bot-user ID):

```sh
node .github/scripts/shipping-rules.cjs "$PUBLISHER_APP_ID" > /tmp/shipping-rules.json
```

The command only writes JSON. Inspect it before separately applying each object
through the GitHub ruleset API or UI. Preserve the existing review ruleset.
The proposed rules require:

- Main merges through the queue, `ALLGREEN`, merge commits, one candidate at a
  time, with a 60-minute check deadline including environment approval time.
- `Compatibility required`, `Test (Node 20)`, `Test (Node 22)`,
  `Test candidate contract runner`, and `Validate manifests & version`, bound to
  GitHub Actions App 15368. Verify these names and the App against actual runs.
- Creation of `v*` tags only by the dedicated publisher App.
- A separate rule prohibiting update/deletion of `v*` tags, with **no bypass**.

The separate tag rules matter: granting the publisher bypass on a combined
creation/update rule would also let it retarget tags. Creating an old tag can
execute the workflow stored in that old commit, so changing the new release
workflow alone is insufficient. Do not grant main-rule bypass to the publisher.

## Activation and hosted acceptance

First rehearse this setup on a disposable repository with copied history and
synthetic candidates, an independently scoped publisher App, and no production
release target. Supply narrowly scoped dependency access only after review.
Do not intentionally ship a bad candidate to the production main branch.

1. Review and land the workflows and their runtime prerequisites under the
   existing protections. Freeze ordinary merges and manual tagging during the
   configuration transition. Since the marketplace serves main, review the
   bootstrap commit as a user-facing deployment.
2. Configure both environments, verify their policies, and install the additive
   queue/check/tag rules. Confirm that every required check appears on both PR
   and merge-group commits. Do not enable required checks before the workflows
   that produce them exist on main.
3. Queue a known-good candidate. Confirm the private job waits for independent
   approval, then all suites and final aggregation succeed. Verify the recorded
   producer SHA equals the merge-group SHA and the resulting main commit. If the
   hosted merge strategy changes the commit, stop and repair orchestration.
4. In the disposable rehearsal, use an intentionally incompatible dependency
   pin. Confirm that private compatibility fails, `Compatibility required` fails,
   and the merge queue removes the candidate. Also exercise missing artifacts,
   cancellation, check timeout, and a changed candidate. Earlier successful run
   artifacts must not admit the new candidate.
5. Rehearse release dispatch with good and bad candidates. A failing compatibility
   run must never start the publisher job. Advance main while publication awaits
   approval and verify no tag/release is created. Verify manual tag creation and
   publisher tag retarget/deletion are denied. Then publish a synthetic good
   release and inspect its tag SHA and archive bytes.
6. Retain run URLs, candidate/dependency revisions, content-free acceptance
   artifacts, effective rules, denial evidence and review identities in the
   internal rollout record. Recheck the production configuration without
   weakening it for the rehearsal.

A successful public PR run proves only public CI and queue admission. Local
policy tests and workflow lint cannot prove GitHub environment/queue enforcement.
Hosted good/bad receipts remain an activation requirement. Missing environment
metadata access must be investigated; do not remove the preflight to work around
an API failure.

## Maintenance and holds

Changes to `dependencies.json` need review and fresh runs; floating branches are
rejected. Pins must remain retrievable. Test each proposed supported server/client
combination and separately verify the deployed backend versions before upgrading
users. These workflows do not deploy dependencies or expand product support.

If review is unavailable, the queue may time out. Requeue when a reviewer is ready;
do not remove checks or copy a previous success. If publication or compatibility
fails, keep shipping held and repair the candidate. An emergency configuration
change requires the responsible administrator's explicit review, a recorded
reason and restoration verification; there is no automatic bypass or rollback
that disables the gate. Keep main, tag and environment policy changes auditable.

References: [merge queues](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue),
[protected environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments),
[ruleset API](https://docs.github.com/en/rest/repos/rules), and
[scoped App tokens](https://github.com/actions/create-github-app-token).

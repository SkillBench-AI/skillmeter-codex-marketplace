# Stable distribution

`main` is the integration branch. `stable` points to a published, validated
release commit. Updating the stable marketplace must not install unreleased
changes from main. Collector destination (dev or production) is independent of
the installation channel.

## Activation

The promotion workflow is prepared for review. Do not advertise stable as the
installation default until the branch exists and hosted acceptance passes.
Existing installations keep their configured source; no automatic migration is
performed. The main-based installation instructions remain valid meanwhile.

1. Land the reviewed promotion workflow and tests. Keep the existing release
   workflow and its compatibility gates. Promotion accepts both tag-triggered
   releases and the reviewed main-dispatch release workflow.
2. Finish the release publisher setup: a dedicated repository-scoped GitHub App,
   contents-write permission, and the `release-publisher` environment. The
   environment must require an independent reviewer, prevent self-review,
   disable administrator bypass, and allow only branch `main`. Store
   `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` there. Reuse the release
   publisher identity; do not introduce a developer token or second publisher.
3. Retain immutable `v*` tags with no update/deletion bypass. Render two additive
   stable rulesets with the publisher's App ID, inspect them, then apply through
   the GitHub ruleset API or UI:

   ```sh
   node .github/scripts/stable-channel.cjs rules "$RELEASE_APP_ID"
   ```

   `stable-promotion` permits creation/update only by that App.
   `stable-integrity` prohibits deletion and force pushes, including by the App.
   Preserve existing main/PR rules. The helper prints configuration only.
4. Rehearse good and denied promotions in the separately authorized shipping
   sandbox. Verify actual server enforcement, not just the configuration JSON.
   Finish installed-state migration validation before moving existing users.
5. Promote the chosen published release. Only then update the public install
   default and any installer/distribution entry points to `--ref stable`.

This does not activate repository settings or install a plugin by itself.

## Promote a release

Publish and validate the release through the existing process. Install its exact
Git ref in an isolated profile and record its version/commit, hook trust,
capture OFF/ON behavior, structured tool pairs and queue revocation results.
Retain only sanitized evidence in a same-repository PR/issue comment or Actions
run. The evidence link is a human attestation reviewed by the environment
reviewer; the script does not infer a passing smoke test from the URL.

Dispatch **Promote stable** from `main` with:

- Published `tag` and full `release_sha`.
- `release_run_id`: successful `.github/workflows/release.yml` run for that SHA.
- `expected_stable`: current full SHA, or `absent` for bootstrap.
- `smoke_evidence_url`: the reviewed installed-test evidence.

Promotion verifies tag/manifest equality, published release/archive existence,
release-run identity, main ancestry, publisher/branch/tag protections and the
expected old stable value. Existing stable requires a greater version and a
fast-forward. Retrying an already-promoted commit is read-only. Missing metadata
or permissions hold promotion. The candidate's code is not executed with the
publisher token. Only ref mutations receive the scoped write token; metadata
reads use the workflow's read token.

A read-only preflight validates release evidence and the expected stable ref before
requesting approval. It needs no publisher credentials. Only successful preflights
enter the serialized approval queue. Publisher protections and all release metadata
are checked again after approval. Promotions use server-enforced
non-force updates. A competing creation/update or unexpected observed result
fails the run. GitHub does not provide a transaction spanning all these reads
and the ref update; protected refs and the single publisher are required.
An administrator changing protection settings remains outside this guarantee.
Do not manually push stable or bypass protections when a promotion holds.

If a release has a defect, stop further promotions and prepare a reviewed fix
with a higher version. Do not move tags, force stable backward, erase queue
state or downgrade consent storage as an automatic recovery action.

## Installation after activation

For a new installation:

```sh
codex plugin marketplace add SkillBench-AI/skillmeter-codex-marketplace --ref stable
codex plugin add skillmeter@skillbench
```

Refresh the marketplace and installed plugin as described in the main README.
Restart Codex and confirm the installed version. Engineers can explicitly choose
`--ref main` in an isolated development profile. The same marketplace identity
cannot be registered twice with different refs in one profile.

### Existing installations

Codex CLI 0.156.1 requires removing the old registration before changing its ref.
In a synthetic isolated profile, this sequence selected stable correctly:

```sh
codex plugin marketplace remove skillbench
codex plugin marketplace add SkillBench-AI/skillmeter-codex-marketplace --ref stable
codex plugin add skillmeter@skillbench
```

Do not apply this as a bulk migration. Before using it with real telemetry:

- Confirm stable is at least the installed version; stop on a downgrade.
- Inventory the configured source and locate the actual persistent data path.
  Versioned-install data must be migrated through the reviewed storage upgrade
  path before replacing an installation. Preserve credentials, consent, pending
  queues, cursor high-water marks and disabled-interval boundaries.
- Check the desktop installed version, enablement and hook trust after switching.
  Verify one active copy of each expected hook. Do not reset consent, remove data
  directories or replay history to repair an installation problem.

The synthetic test proves ref isolation and installation selection. It contains
no real hooks or credentials and does not establish desktop trust or legacy
queue migration safety. Local-checkout installations need their own reviewed
checkout/update procedure; marketplace refresh does not pull their repository.

## Repeatable checks

```sh
node --test plugins/skillmeter/test/stable-channel.test.js
CODEX_MARKETPLACE_SMOKE=1 node --test plugins/skillmeter/test/stable-channel.test.js
npm run check
```

The optional host test requires Codex CLI and Git. It creates a temporary home,
uses Git URL rewriting to a local synthetic repository, and does not use the
operator's credentials, configuration, hooks or telemetry. It verifies a
main-to-stable registration change, isolation while main advances, and updating
after stable is promoted. Hosted good/bad promotion tests remain separate.

References: [Codex marketplaces](https://developers.openai.com/plugins/build/plugins),
[GitHub rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets).

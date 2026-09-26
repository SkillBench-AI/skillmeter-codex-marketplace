# Releasing SkillMeter for Codex

The marketplace serves `main`: merged changes reach users when they update.
Version tags separately publish GitHub Releases and source archives.

## Version and tag

The version lives in
[`plugins/skillmeter/.codex-plugin/plugin.json`](plugins/skillmeter/.codex-plugin/plugin.json).
Use `MAJOR.MINOR.PATCH` without prerelease or build suffixes. Include a version
bump in a release PR: patch for fixes, minor for features. Before 1.0, breaking
changes may use a minor bump.

Before enabling publication, complete [shipping gate setup](compatibility/SHIPPING.md).
The workflow requires reviewed dependency pins, protected environments and a
dedicated publisher App. Missing configuration holds publication.

After the release PR passes the merge queue and reaches `main`:

1. Dispatch the [Release workflow](.github/workflows/release.yml) from `main`:

   ```sh
   gh workflow run release.yml --ref main
   ```

2. The compatibility reviewer checks the exact candidate and dependency pins,
   then approves the `compatibility-reviewed` environment. Fresh tests cover the
   combined producer, Claude client, collector and reader.
3. The publisher reviewer checks that successful run before approving the
   `release-publisher` environment. The workflow checks that the tested commit is
   still main, creates the manifest's version tag and publishes its source archive.
   If main advances or the acceptance result becomes more than one hour old
   while review is pending, dispatch a fresh run.

Do not push release tags manually. Tag creation is reserved for the dedicated
publisher App; separate rules prevent all actors, including that App, from
retargeting or deleting version tags. An existing tag at another commit is a
hard stop: review a new version bump instead. If publication stops after creating
a tag, rerun only while the same commit is still main; otherwise investigate the
incomplete release before proceeding. An existing release requires inspection;
the workflow does not overwrite it or assume its assets are complete. A tag alone
is not a completed release.

## Release notes

Prepare and review the user-facing notes before dispatching the release. The workflow
publishes automatically; replace its generated title and body with the approved
notes afterward. Follow the latest published release's tone and command layout:

- Title: `SkillMeter X.Y.Z`
- `### What changed`: concrete user-facing changes.
- `### After updating`: numbered steps with command blocks; distinguish Git
  marketplaces from local checkouts where needed.
- `### Known limitations`: brief, relevant limitations.
- End with `Details: #PR`.

Keep internal coordination and rollout history in Linear. Public notes should
contain only information users need to update and use the plugin.

## Checks

`npm run check` runs version validation, manifest and contract validation, and Node tests.
[PR CI](.github/workflows/ci.yml) tests Node 20 and 22. For optional local hooks,
install [pre-commit](https://pre-commit.com/) and run `pre-commit install`.

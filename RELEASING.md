# Releasing SkillMeter for Codex

The marketplace serves `main`: merged changes reach users when they update.
Version tags separately publish GitHub Releases and source archives.

## Version and tag

The version lives in
[`plugins/skillmeter/.codex-plugin/plugin.json`](plugins/skillmeter/.codex-plugin/plugin.json).
Use `MAJOR.MINOR.PATCH` without prerelease or build suffixes. Include a version
bump in a release PR: patch for fixes, minor for features. Before 1.0, breaking
changes may use a minor bump.

After merging the release PR:

1. Update main and run the checks:

   ```sh
   git checkout main
   git pull --ff-only
   npm run check
   ```

2. Create and push an annotated tag matching the manifest:

   ```sh
   VERSION="$(node -p "require('./plugins/skillmeter/.codex-plugin/plugin.json').version")"
   git tag -a "v${VERSION}" -m "SkillMeter ${VERSION}"
   git push origin "v${VERSION}"
   ```

3. Confirm the [release workflow](.github/workflows/release.yml) succeeds.
   It checks the tag against the manifest, validates manifests, runs tests,
   and publishes a source archive with generated release notes.

## Release notes

Prepare and review the user-facing notes before pushing the tag. The workflow
publishes automatically; replace its generated title and body with the approved
notes afterward. Follow the latest published release's tone and command layout:

Release notes are public. They say what changed for the user; the PRs hold the
rest.

- Title: `SkillMeter X.Y.Z`
- `### What changed`: the user-visible outcome, one sentence per bullet, at
  most three bullets. Describe what the user can do or will notice. No command
  flags, file or module names, policy or schema versions, retry counts,
  algorithms or ADR references. A change users cannot notice stays in its PR.
- `### After updating`: numbered steps with command blocks; distinguish Git
  marketplaces from local checkouts where needed. Do not add sentences about
  what is not needed.
- `### Known limitations`: only what this release adds or changes, each as what
  the user will see and, where there is one, what to do. Otherwise
  `Unchanged from X.Y.Z.`, naming the release that lists them.
- End with `Details: #PR, #PR`: PR numbers only. ADRs and privacy documents are
  reachable from the PRs.

Keep internal coordination and rollout history in Linear. Public notes should
contain only information users need to update and use the plugin.

## Checks

`npm run check` runs version validation, manifest validation and Node tests.
[PR CI](.github/workflows/ci.yml) tests Node 20 and 22. For optional local hooks,
install [pre-commit](https://pre-commit.com/) and run `pre-commit install`.

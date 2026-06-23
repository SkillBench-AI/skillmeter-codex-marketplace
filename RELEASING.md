# Releasing SkillMeter for Codex

This repo follows a tag-driven release flow. Continuous integration gates every
change, and a published GitHub Release is produced automatically when a version
tag is pushed.

## Versioning policy

- The **plugin version is the single source of truth**, declared in
  [`plugins/skillmeter/.codex-plugin/plugin.json`](plugins/skillmeter/.codex-plugin/plugin.json).
- Versions are **clean [SemVer](https://semver.org/)**: `MAJOR.MINOR.PATCH`
  with no pre-release or build-metadata suffix (e.g. `0.2.0`, never
  `0.2.0+codex.20260616192913`). The marketplace tooling sorts and de-dupes on
  the bare version, so suffixes are not used.
- Bump the version in the same PR as the change that warrants a release, using a
  conventional-commit subject (`feat: ...` → minor, `fix: ...` → patch, breaking
  change → major while pre-1.0 may stay in the minor slot).

`node .github/scripts/check-version.mjs` enforces the clean-SemVer rule in CI,
in the release gate, and via the local pre-commit hook.

## Tag strategy

- One tag per release: `vMAJOR.MINOR.PATCH` (the `v` prefix + the exact plugin
  version, e.g. `v0.2.0`).
- Tags are created **only on `main`** after the version-bump PR is merged.
- Use **annotated** tags so the release has a message and author.
- The release workflow refuses to publish if the tag does not equal
  `v<plugin.json version>`, so a tag can never ship a mismatched manifest.

## Cutting a release

1. Land a PR that bumps `version` in `plugin.json` (and any changelog/docs).
2. Pull the merged `main`:

   ```bash
   git checkout main && git pull --ff-only
   ```

3. Validate locally:

   ```bash
   npm run check          # version + manifests + tests
   ```

4. Create and push the annotated tag (must match the plugin version):

   ```bash
   VERSION="$(node -p "require('./plugins/skillmeter/.codex-plugin/plugin.json').version")"
   git tag -a "v${VERSION}" -m "skillmeter v${VERSION}"
   git push origin "v${VERSION}"
   ```

5. The [`Release`](.github/workflows/release.yml) workflow then:
   - re-checks the tag/version match and manifests,
   - runs the full test suite,
   - packages a source archive, and
   - publishes a GitHub Release with auto-generated notes.

## What CI runs

- **On every PR and push to `main`** ([`CI`](.github/workflows/ci.yml)):
  clean-SemVer check, manifest validation, and the unit tests on Node 20 and 22.
- **On a `v*` tag** ([`Release`](.github/workflows/release.yml)): the same gate
  plus tag/version matching, archive packaging, and GitHub Release publication.

## Local checks

```bash
npm run check:version    # plugin.json is clean SemVer
npm run check:manifests  # marketplace + plugin manifests are valid
npm test                 # node --test (unit tests)
npm run check            # all of the above
```

Optionally install [pre-commit](https://pre-commit.com/) to run these
automatically: `pre-commit install`.

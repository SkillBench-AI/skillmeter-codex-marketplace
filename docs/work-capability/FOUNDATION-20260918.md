# Work foundation checkpoint, September 18

Independent preparation only. No Work delivery, consent-policy or broker-auth
implementation was added. Original checkouts and canary state are untouched.

## Current source and review boundary

Plugin source `946683f90b33903defdfa810e724c2dda04f7fe8` incorporates Seungho's
latest #37 (`462d67e39e05b25976cdc49ebd4f321a542cec55`) without changing its auth
contract. The Work-only product/test diff is nine files, 628 additions and two
deletions. Review with `git diff 462d67e 946683f -- plugins`. Earlier native canary
results were on older code; they were **not** rerun on this foundation.

Pipeline source `ce9fb9789c0864805920cdc8845c62eec1dfd6d1` merges current main
`bd5dfea660cb5e09475536169adca55275f59fc8` into the Work candidate, retaining
PR148. Its Work-specific changes remain the 16 product/test/doc files in
`git diff fd5a758 3abe812f -- packages/preprocessor apps/ai-usage-analyser`.
The merge adds current upstream manager-report/contracts work, not new Work scope.

| Foundation / capability | Status and evidence |
| --- | --- |
| Plugin Work delta on latest #37 | Supported in synthetic tests; patch applies cleanly |
| Plugin Work delta directly on released main `a2e1e061` | Unsupported: missing consent/retention/session-metadata foundation and overlapping logger/queue changes |
| Pipeline Work delta directly on main | Unsupported: Codex parser/diagnostic foundation from #148 is absent |
| Pipeline Work stack plus current main | Synthetic preprocessing, analyzer and synthesizer suites pass |
| Broker-only Work identity | Unsupported by current adapter; it still requires GitHub/user-alt identity. Contract remains #3's gate |
| Native app restart | Historical pass only; refreshed stack needs a new scoped canary |
| Full machine restart | Deferred by user |
| Work upload, real analysis, correct-user dashboard | Unverified; sender remains unimplemented |
| Cloud Work / ordinary chat | Unsupported |

## Fresh validation

- Plugin `npm run check`: **501 Node tests, 55 lifecycle cases**, version and
  manifest checks pass. Lifecycle cases still describe the older ADR001 contract;
  green tests do not establish compliance with the broker amendment.
- Pipeline: **190 preprocessor, 333 analyzer, 322 synthesizer tests + six
  subtests** pass. Analyzer retains 18 existing datetime deprecation warnings.
- Synthetic Work queue → refreshed parser: three messages and one linked outer
  tool pair, no startup history, delivery disabled.
- Expiry-retention and read-only credential probes both pass.
- No dependency installation, model request, production-data read or hook install.

## Reproduce the isolated delta check

`prepare_delta.py` reads committed Git objects, exports the target into a
temporary directory, writes a Work-only patch and checks applicability. It does
not apply the patch to a checkout. Exit 2 means reconciliation is needed, not a
runtime failure. Exit 0 does not mean safe to install or ship.

```sh
python3 docs/work-capability/prepare_delta.py --repo . \
  --base 462d67e --candidate 946683f --target origin/main \
  --scope plugins --output /tmp/work-plugin-main
```

Use `--target 462d67e` for the passing #37 comparison. Pipeline arguments are
`--repo <pipeline-checkout> --base fd5a758 --candidate ce9fb978 --target origin/main
--scope packages/preprocessor apps/ai-usage-analyser`. The emitted manifests name
exact revisions and conflicting files; no transcript contents are inspected.

## Resume

Keep both Work branches separate from existing repair PRs. After #37's broker,
credential and consent decisions, refresh this stack and rerun the same checks.
After #148 lands, recheck the pipeline-only delta against main. Then prepare
focused draft PRs and a fresh scoped canary; do not revive the deleted canary
grant. Keep authenticated delivery and production enablement as later work.

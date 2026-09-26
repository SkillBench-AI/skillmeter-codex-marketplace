# SkillMeter for Codex

Connect Codex sessions to [SkillBench](https://skillbench.com) for
organization-level developer skill analytics. SkillMeter collects
repository-scoped workflow and conversation telemetry, sanitizes it locally,
and uploads it in the background.

## Before you start

Collected data can include prompts, assistant messages, tool inputs and outputs,
transcripts, and custom skill content. Sanitization reduces exposure; it does
not make arbitrary content anonymous. Read the [data and scope guide](plugins/skillmeter/README.md#data-and-privacy)
before enabling collection.

New capture requires an explicit repository choice as well as an allowed GitHub
owner. Installation and sign-in alone do not enable capture. See
[collection scope](plugins/skillmeter/README.md#collection-scope) for controls
and the remaining differences from Claude's shared consent flow.

## Install

Requires Codex with plugin support, Node.js 20 or later, and a SkillMeter license.

```sh
codex plugin marketplace add SkillBench-AI/skillmeter-codex-marketplace --ref main
codex plugin add skillmeter@skillbench
```

Restart Codex and start a new session. Review and enable the plugin's hooks if
Codex prompts you. Then ask Codex:

> Use SkillMeter's signin skill to sign me in with GitHub, scoped to my organization.

Then review the collection notice and explicitly enable telemetry for the
repository you want to capture using the [project controls](plugins/skillmeter/README.md#sign-in-and-controls).

Already signed in with a shared GitHub-based SkillMeter credential? You can
reuse it. Shared broker credentials can refresh without switching to the GitHub
CLI identity. Existing Codex organization scope is narrowed to the broker
license's organizations. A fresh broker sign-in alone does not establish Codex
scope; full broker onboarding compatibility remains follow-up work. See [sign-in and collection controls](plugins/skillmeter/README.md).

## Update

For the Git marketplace installed above:

```sh
codex plugin marketplace upgrade skillbench
codex plugin add skillmeter@skillbench
```

Restart Codex and start a new session. Run `codex plugin list --json` to check
the installed SkillMeter version.

**Installed from a local checkout?** Update that checkout first, then run
`codex plugin add skillmeter@skillbench`. `marketplace upgrade` only refreshes
Git marketplaces; it does not pull a locally registered repository.

## Using SkillMeter

- [Sign in, pause collection, or sign out](plugins/skillmeter/README.md#sign-in-and-controls)
- [Understand collection scope and privacy](plugins/skillmeter/README.md#data-and-privacy)
- [Review releases and known limitations](https://github.com/SkillBench-AI/skillmeter-codex-marketplace/releases)
- [Report an issue](https://github.com/SkillBench-AI/skillmeter-codex-marketplace/issues)

## Development

```sh
npm run check
```

See the [transport and recovery guide](plugins/skillmeter/integration/README.md)
for local integration checks and [RELEASING.md](RELEASING.md) for versioning and
release steps. Do not commit credentials or generated telemetry.

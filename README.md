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

New capture requires explicit organization and repository choices in Codex as
well as an allowed GitHub owner. Installation and sign-in alone do not enable
capture, and choices made in SkillMeter for Claude Code do not apply here. See
[collection scope](plugins/skillmeter/README.md#collection-scope) for controls.

## Install

Requires Codex with plugin support, Node.js 20 or later, and a SkillMeter license.

```sh
codex plugin marketplace add SkillBench-AI/skillmeter-codex-marketplace --ref main
codex plugin add skillmeter@skillbench
```

Restart Codex and start a new session. Review and enable the plugin's hooks if
Codex prompts you. Then ask Codex:

> Use SkillMeter's signin skill to sign me in.

Then review the collection notice and record organization and repository
consent for the repository you want to capture using the [project controls](plugins/skillmeter/README.md#sign-in-and-controls).

Sign-in opens the SkillBench sign-in service, where you pick your workspace.
This plugin keeps its own session, separate from SkillMeter for Claude Code. See
[sign-in and collection controls](plugins/skillmeter/README.md#sign-in-and-controls).

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

# Offline lifecycle acceptance

Run `npm run check:lifecycle` from the repository root. It needs Node >=20 and
Git, with no dependency installation, accounts, services or real telemetry.
For machine-readable evidence, run:

```sh
node plugins/skillmeter/integration/lifecycle/run.cjs > lifecycle-result.json
```

Exit 0 means all checks passed. Exit 1 means at least one acceptance failure or
fixture error; exit 2 means the runner itself could not start. Each child has a
10-second limit. The report contains case names and assertion labels only.

This is a strict, initially failing suite against accepted
[ADR001](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/0ea513751149a23fcc063fb8f045794657ceb031/docs/adr/001-license-token-lifecycle.md),
decisions 2–4. It is separate from `npm test` and current regression CI because
the production implementation has known gaps. There are no skipped cases,
expected-failure annotations or automatic correction attempts. A green existing
CI run does not mean lifecycle acceptance passed. Keep PR #37 draft.

| Requirement | Checks |
| --- | --- |
| Background refresh | Healthy token, empty queue, concurrent callers, recovery before both queues drain |
| Capture vs delivery | Capture events/chunks during expiry, prohibit expired-token delivery |
| Refresh recovery | Network, 404, 503 and malformed responses stay on refresh; 401/410 use identity-bound activation |
| Prior sign-in | No marker, signed-out sentinel, GitHub ID before activation, minted GitHub ID/sub/org/audience mismatch |
| Removal | Signout and refresh/activate 402 remove both payload kinds; repository/org OFF removes both |
| Retention | Keep payloads at six days, delete them after eight days |
| Retry status | Persist gh-unavailable terminal state, exponential delays through the 30-minute cap, stop retries at terminal state and reset backoff after success |

Each case runs real Codex modules in a new child with synthetic credentials,
temporary HOME/state/plugin/session directories, isolated Git configuration and
a fake `Date`/`Date.now`. Only the existing Git executable is allowed for repository
inspection. Shell calls are denied except a scripted `gh auth token`; Keychain,
detached children and sockets are denied. `fetch` is replaced with an explicit
route table; unexpected operations make the result an error even if production
code catches the exception. No actual refresh, activation or delivery occurs.
The fixture uses the pinned Claude `license-status.json` schema for the status
contract; it does not introduce a second production status format.

An assertion failure stops that case, so later assertions in a failing case are
not evidence of passing behavior. These checks are a bounded contract, not an
exhaustive lifecycle proof: separate-process lock races, actual SessionStart
and sign-in terminal reset, upgrade-marker migration, expiry inside a running host, and
retention without resurrecting expired chunks during baseline recovery still
need follow-up. Retention cases also set payload mtimes explicitly. Clock control
does not advance real sleeps or OS process lifetime. Server token TTL/signature validation and dashboard mapping
require the scoped live canary.

Correction budget for this iteration: one pass correcting fixture defects and
one final verification. Production lifecycle repairs require a subsequent
bounded change; never weaken an acceptance requirement to get a green result.
See `docs/lifecycle-checkpoint.md` for the recorded baseline and resume steps.

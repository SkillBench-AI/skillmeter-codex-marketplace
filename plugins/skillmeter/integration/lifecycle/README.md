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

The suite covers the draft's implementation of the pinned
[ADR001](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/0ea513751149a23fcc063fb8f045794657ceb031/docs/adr/001-license-token-lifecycle.md),
decisions 2–4. Current Claude broker authentication supersedes parts of that
contract; see [compatibility](../../../../docs/claude-parity.md#compatibility).
`npm run check` and CI require this suite. Passing it does not prove compatibility
with current Claude or live delivery.

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

An assertion failure stops that case; later assertions are not evidence of
passing behavior. Additional cases cover sign-out during refresh, new sign-in
superseding old results, explicit activation revocation, session/sign-in resets,
marker migration, deletion faults, busy purge retry, missing-cursor retirement,
malformed retirement journals, mixed-age events, legacy payload deletion and
retirement across baseline resets. The regular Node tests also exercise a
separate lock-owning process and recovery after that process is killed.

This is a bounded offline contract. It does not prove simultaneous writes by
current Claude and Codex clients, OS/runtime behavior across an installed-client
upgrade, actual server TTL/signature enforcement, or dashboard user mapping.
Retention cases set payload mtimes explicitly; clock control does not advance
real sleeps or OS process lifetime. 

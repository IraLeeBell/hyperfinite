# Portfolio operator runbook

Run the integrated offline checks from a clean exact repository head:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run validate:demos
npm run simulate:demos
npm run validate:hardening
```

`validate:demos` fails on an omitted or partial contract pair, unknown demo
directory, reordered catalog, duplicate identity, generic runtime fallback,
missing agent/skill/workflow/lock, Phase Contract mismatch, unregistered fixed
command, malformed JSON asset, recovery-fixture omission, or action-lock drift.

`simulate:demos` is hermetic by default. It uses fixed clocks, keys, IDs,
in-memory trust stores, fake model/GitHub ports, and isolated local Git. It must
load one exact closed, zero-valued external-call assertion fixture per demo.
Run it twice and compare the complete output bytes. Any `live`, `apply`,
`execute`, GitHub, network, credential, or paid-inference option is rejected
before environment or credential reads.

Do not run pack test/build commands inside the privileged runtime bridge.
The built-in runner is Git-only and refuses every non-Git command. Treat a
separately isolated credentialless runner as an undeployed prerequisite, not
as an implied fallback.

Before sandbox activation, administrators must deploy that sealed hermetic
runner with the fixed App/Feature command catalog and authenticated Security
regression/lock/threat/DLP/scanner evidence. The repository bridge intentionally
refuses those commands without it.

Each hands-off path stops at Human Review. Completed is shown only in a
separate synthetic-human continuation that supplies eligible independent
current-head evidence to the Control Kernel. Automation cannot approve,
merge, mark ready, dismiss, deploy, publish, or change administration.

On a refusal or block, retain the signed receipts and fixtures. Do not infer
authority from Project drift or retry an ambiguous write. Reconstruct from
Kernel state, authenticate the durable predecessor, and use the exact
pause/resume/block/cancel/repair/replan/revision/retry/reauthorization route.

`validate:hardening` executes the closed scenario and fault-boundary plan
against the actual tests and simulator. It rejects failed, errored, skipped,
todo, missing, or duplicate testcase evidence, non-deterministic simulation,
nonzero or missing fixture-declared external-call assertions, or a weakened
readiness classification. Run it twice and compare complete output bytes.

These counters validate only the explicit GitHub, network, credential, and
paid-inference declarations in each demo's dedicated closed assertion fixture.
Missing, renamed, extra, cross-demo, or nonzero categories fail. They are not
runtime telemetry, an OS-level network sandbox, or proof about
provider/platform processes. The separately isolated credentialless runner
remains an undeployed administrator prerequisite.

Repository/hermetic-demo-ready does not mean live-ready. Follow
[activation and readiness](activation-and-readiness.md); do not provision a
Project, install an App, deploy a service, or enable a canary from this
repository workflow.

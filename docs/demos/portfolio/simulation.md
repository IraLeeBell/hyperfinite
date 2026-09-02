# Hermetic portfolio simulation

Run:

```bash
npm run --silent simulate:demos > first.json
npm run --silent simulate:demos > second.json
cmp first.json second.json
npm run --silent simulate:demos -- --format=ndjson > trace.ndjson
```

The default JSON contains the exact four journeys, real runtime probe results,
separate synthetic-human completion receipts, signed pack review-evidence
digests, redacted audit chains, recovery/adversarial fixture digests, 96
directed cross-demo substitution refusals, an isolated local-Git commit, and
closed zero-valued fixture-declared external-call assertions.

For each demo the probe calls the actual reconstruction, dispatcher,
persisted-dispatch validator, Control Kernel, Kernel-first reconciliation,
projection converger, and scheduler. Projection uses compare-and-swap plus
read-after-write and writes Stage last. The full hands-off journey is rebuilt
as a signed artifact/fence/receipt chain, reconstructed by the runtime, and
dispatched/scheduled at Human Review. Stage, model-call, and audit records are
derived from that reconstructed evidence. Each model stage invokes the
deterministic fake provider, which emits signed start/completion and fixed
token/cost usage evidence; no paid provider is contacted. Each journey uses
its pack-specific Work Accord policy, capability registry, Phase Contracts,
and a matching synthetic Domain Pack. Enterprise-required prohibited effects
are added as further narrowing; pack authority is never replaced by a generic
policy.

Every cross-core happy-path boundary, including capture and activation, calls
the actual Control Kernel with the exact pack Phase Contract and closed
predicate/evidence vocabulary. Stage receipts bind the resulting applied
Kernel result and snapshot digests; same-core stages retain unchanged Kernel
evidence.

The synthetic-human continuation consumes that same reconstructed Human Review
snapshot and the pack-specific human-review Phase Contract. Feature Delivery
and Security Remediation use their fixed independent-human predicates from the
Kernel's closed requirement vocabulary. The applied terminal Kernel result is
then committed as a human-produced artifact, signed stage receipt, and
`DemoRunState` at Completed.

The twelve ordered source-to-target substitutions across four demos are tested
through the signed review consumer, runtime reconstruction, exact trusted
binding loader, and bounded-grant validator for repository/issue/Project
binding, Work Accord/profile, artifacts, receipts, approvals, budgets, agent
bindings, and allowed-path grants. Every case refuses before inference and
effects.

Each substitution class accepts only its expected typed refusal pattern and
records that refusal digest. Unrelated exceptions fail the simulator.

All four verification Phase Contracts declare the real
`replan-requested` exit guarded by `work-accord-current`; their bound Work
Accord digests and Security Remediation content-addressed registration chain
are updated together.

The simulation consumes each pack's hands-off, synthetic-human, recovery, and
adversarial fixtures. Duplicate, out-of-order, concurrent, stale, partial,
lost-ack, pause, resume, cancel, repair, replan, revision, retry-limit, and
reauthorization behavior is re-executed by the deterministic runtime and
pack-test harnesses before the trace is emitted. Each recovery ID maps to an
exact passed JUnit testcase identity; runner summaries and skipped tests cannot
satisfy coverage. Substitution outcomes are
derived by calling the portfolio binding validator for every directed pair;
they are not status constants. Behavior stays deterministic and grants no
authority.

`npm run validate:hardening` layers the closed issue-30 matrix over this real
simulator and the actual boundary tests. It expands every named scenario over
all four demos, requires demo-specific pack anchors, verifies every named
credential/effect/recovery boundary from passing JUnit evidence, runs this
simulator twice byte-for-byte, and emits canonical evidence only when the
closed fixture-declared GitHub/network/credential/paid-inference assertions are
zero. Each scenario-demo digest includes that demo's complete simulator-result
digest. Each demo must supply one closed, demo-bound declaration containing
exactly all four categories; missing, renamed, extra, or nonzero values fail.
These assertions are not runtime telemetry and do not claim OS-level network
isolation; that requires the separately deployed credentialless runner.

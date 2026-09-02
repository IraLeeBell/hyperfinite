# Autonomous demo runtime foundation

## Status

The deterministic runtime foundation and all four demo registrations are
current. The shared runtime remains an offline, injected-port implementation;
demo-specific profiles, agents, skills, workflows, and Project schemas compose
through validated per-demo shards. The repository includes no live credentials,
paid inference, Project provisioning, approval, merge, deployment, or
publication service.

## Authority

Runtime behavior remains subordinate to:

1. lifecycle graph;
2. Work Accord and Phase Contracts;
3. policy compiler and Capability Registry;
4. Control Kernel;
5. trusted adapter;
6. Single Writer; and
7. model output.

The runtime cannot select a repository, issue, pull request, Project item,
route, capability, credential, effect, approval, or merge from model output.

## Reconstruction

`reconstructDemoRuntime()` consumes validated immutable inputs:

- the exact catalog, reservation manifest, per-demo contract set, lifecycle,
  base registry, and Work Accord;
- `DemoRunState`, the full signed stage-receipt prefix, artifact envelopes, and
  one linear run-fence chain;
- the current schema-valid Kernel snapshot and exact receipt head;
- the current Activation Lease and content-addressed `DemoBudgetState`; and
- a content-addressed `DemoProjectionState`.

JSON loaders are bounded and use duplicate-key-safe strict parsing before schema
validation. Every returned document is a canonical immutable snapshot.
Reconstruction rejects cross-demo evidence, gaps, forks, stale generations,
receipt/artifact/fence substitution, a budget behind Kernel usage, and a
projection that leads or diverges from Kernel.

## Binding domains

The runtime carries two deliberately non-interchangeable digests:

| Field | Derivation | Purpose |
|---|---|---|
| `bindingDigest` | canonical digest of complete `TrustedGitHubBinding` | adapter target identity |
| `kernelBindingDigest` | `workAccordBindingDigest()` over repository ID, exact work-item node ID, and Work Accord source digest | Kernel target identity |

Both are required in signed runtime state, redemption candidates, signed
authorizations, redemption keys, ledger heads, and execution bundles. The
signed Work Accord source digest is retained so the Kernel identity is
recomputed rather than trusted as a caller assertion. Changed
signature, authorization, candidate, redemption, and ledger payloads carry
explicit domains. The bridge recomputes the complete GitHub digest and checks
the Kernel digest against the actual `evaluateTransition()` result. Missing,
legacy, copied, substituted, or swapped evidence fails closed.

The signed runtime state and authorization wire documents are version `2.0.0`.
Legacy `1.0.0` evidence has no migration path: the deterministic migration plan
requires reissuance because signatures, one-time nonces, binding fields, and
redemption domains cannot be rewritten safely.

## Activation

`activateDemoIssue()` accepts only:

- the exact reviewed catalog/profile/binding/capability tuple;
- the configured issue-form source and numeric submitter;
- explicit consent in the configured field;
- current profile validity and revocation generation;
- a verified signed lease with the exact fixed call/token/cost/parallel limits
  and complete active-phase authority;
- a zero-use, zero-held budget for the initial generation, or a monotone
  signed recovery-ledger successor bound to the current Kernel receipt and Run
  State for a later generation; and
- one durable single-use activation claim with authenticated readback.

An ambiguous claim is observed twice and accepted only as one stable exact
record. No activation result contains a credential or write capability.

## Dispatch and scheduling

`dispatchDemoRuntime()` derives the first incomplete canonical stage from the
verified receipt prefix and returns one closed Foundation action. A persisted
current-stage artifact chooses receipt finalization or the unique lifecycle
route to the next stage. Project fields never drive the decision.

`CAPTURED` is a pre-cursor Kernel state: it requests the unique activation
transition without being classified as journey drift. Reconciliation into
`ACTIVATION_PENDING` leaves the deterministic intake cursor `ready`; the
dispatcher waits only while exact activation is absent, then runs intake.

`scheduleDemoDispatch()` accepts only a signed, durably persisted dispatch
decision. For a model stage it:

1. validates the exact global stage agent/capability/workflow binding and, for
   a selectable stage, its signed exact-agent grant;
2. validates the single-use activation grant, lease, epoch, generation, and
   budget;
3. atomically acquires one fence keyed by repository numeric ID and the exact
   opaque work-item node ID;
4. conservatively reserves one call, the remaining token allocation, and the
   exact capability cost ceiling;
5. rereads state and revalidates lease, budget, and binding after those awaited
   operations;
6. records one authenticated provider attempt;
7. invokes only the reserved binding through the injected port with the exact
   trusted deadline;
8. reconciles authenticated usage even when the provider fails;
9. settles known usage or holds the full uncertain reservation; and
10. releases the exact fence with readback.

Completion time comes from the injected trusted scheduler clock, never provider
usage. A return at or after the deadline settles authenticated usage, records a
provider-timeout failure, and releases the fence at its logical expiry; it
cannot escape through fence timestamp validation or advance the stage.

All stage workflows share this one serialization domain and cancellation is
disabled. Platform queue order is not authority. A fence loser invokes nothing
and spends nothing.

### Governed user selection

`StageAgentBindingSet@2.0.0` keeps `executionKind` unchanged and declares
`none`, `fixed`, or `user-selectable` participation for every stage. Fixed
stages have one non-user-invocable binding. Selectable stages have at least two
static candidates, stable option keys, no default, and `fallbackPolicy: none`.

`resolveStageAgentSelection()` treats a fresh authenticated Requested Stage
Agent value as untrusted intent. Enterprise and project posture, Work Accord
requested capabilities, the current Phase Contract, stage option allowlist,
Capability Registry, Activation Lease, current actor authorization, exact
repository/work item/Project item, run/attempt/generation/receipt head, current
PR head, budget, and concurrency narrow the candidates to one. The signed grant
binds one agent, skill, capability, workflow, schemas, tools, and budget. A
persisted dispatch and run fence bind its digest, so a later picklist edit cannot
retarget in-flight work. Missing, wrong-stage, stale, replayed, or conflicting
intent refuses inference and requires reconciliation or a new generation.
Grant creation uses an atomic durable store keyed by selection key; exact
duplicates return the existing signed record and conflicting candidates refuse.
The signed runtime-state comment binds that grant digest and its complete
generation, receipt, policy, registry, binding, and budget-authority tuple.
Pre-activation reads
one immutable App-authored
`agentic-framework-stage-agent-selection` marker from the same stable comment
page, validates its signature and exact runtime tuple, and rejects fixed states
that carry a selection grant. Immediately before selected inference, the
scheduler refreshes participation policy and Phase Contract, reads trusted time
again, and caps the provider deadline by grant expiry.

## Kernel and effects

`evaluatePersistedDemoKernelTransition()` directly calls
`evaluateTransition()` with the reconstructed snapshot and trusted context.
The selected route must equal the persisted dispatcher route. The returned
result is canonically snapshotted and cannot be replaced by a compatible-looking
value.

For a cross-core stage completion, `completeDemoStage()` persists and rereads
the applied Kernel result before it signs or appends the stage receipt. The
receipt then passes the Foundation's `advanceDemoJourney()` checks. Same-core
progress cannot supply a Kernel result.

Demo model safe output uses a handle issued only from a fully validated
registration shard. `bridgeRuntimeOutput()` verifies that handle, both binding
domains, exact-success threat evidence, current authorization, and the actual
Kernel capability grant before translating through the existing safe-output
adapter. The resulting plan still requires `GitHubSingleWriter`.

COMMENT writes carry an effect precondition binding the complete fresh
execution-state, binding, plan, effect, and expected head digests. The
GitHub API port must enforce that condition atomically with the mutation. A
head change before claim-attempt recording leaves an unattempted claim; a
change at apply time performs no comment effect.

The privileged bounded-worktree runner executes only trusted Git integrity
operations. Pack build/test/typecheck commands require a separately isolated,
credentialless, network-denied runner and authenticated results; omission
fails closed.

## Projection

Projection values are derived only from the applied Kernel snapshot, verified
stage receipt prefix, Work Accord, trusted binding, profile, binding set, and
validated selection result.
`convergeDemoProjection()`:

1. refuses a projection ahead of Kernel or divergent at the same version;
2. writes each non-Stage projection field in reviewed mapping order while
   leaving Requested Stage Agent as a separate input surface;
3. uses expected-state compare-and-swap and read-after-write verification;
4. reconciles a lost acknowledgement only from stable exact readback; and
5. writes Kernel Stage last—even when its displayed value is unchanged but
   same-core receipt metadata advanced—and verifies the complete final
   observation.

Projection may lag in typed reconciliation. It can never authorize or lead
Kernel state.

## Recovery

Duplicate exact evidence replays without a second effect. Different content
under the same identity is a replay conflict. Delayed or superseded artifacts,
receipts, decisions, fences, generations, or binding epochs are rejected.

Pause and block preserve the stage cursor. Resume preserves it; every
non-terminal exit from Blocked increments both the run attempt and authority
generation. `blocked.cancel` is terminal and preserves generation, attempt, and
budget without requiring a recovery-budget store. Backward scope-repair,
verification-repair/replan,
and review-revision routes use only actual applied Kernel results, increment
generation, and truncate the affected stage suffix. Cancellation is terminal.
Ambiguous mutation, persistence, cost, or Project acknowledgement is never
blindly retried.

Recovery-budget replay is delegated to the durable store's authenticated
compare-and-swap result. An `existing` result must return the exact planned
successor and signed evidence; the runtime revalidates both and their readback.
Recovery evidence always compares to the complete expected transition payload;
signature-only acceptance is not supported. There is no separate pre-write
replay branch.

Reservation, settlement, and recovery successors share the
`agentic-framework.demo-budget-ledger.v1` ledger-head domain, so one durable
chain cannot switch preimage formats between stage work and recovery.

Provider usage reconciliation failures may return a settled failure while
retaining the last verified budget. Budget-store substitution, malformed
settlement evidence, and settlement validation failures are outside that catch
boundary and hard-fail; an unverified budget is never returned as authority.

Planning stages use the existing `ready` run status after both normal entry and
pause/block recovery, matching stage-receipt advancement. A stale Project
projection of `PAUSED`, `BLOCKED`, or `CANCELLED` is treated as lagging after a
later Kernel transition and may converge; only a forward lifecycle state can
lead Kernel and block projection writes. Kernel control states dominate the
stage execution kind, so a blocked human-review cursor persists `blocked`, not
`waiting-human`.

For `retry-requested` or another generation-changing recovery route, Kernel
persistence is followed by a signed, domain-separated budget-ledger transition
that increments authority generation exactly once and increments the durable
retry counter only for `retry-requested`, while preserving
calls, tokens, costs, holds, and prior ledger head. Run-state recovery is not
written until that budget successor and its readback are authenticated;
missing, conflicting, or ambiguous recovery-budget persistence remains in
typed reconciliation. A later-generation activation binds the stable budget
authority digest without resetting lifetime usage. The prior-generation
activation cannot authorize the recovered run.

The durable Kernel store must retain the addressable pre-transition snapshot
and complete applied result until the corresponding stage receipt or recovered
Run State is committed. After a crash in that window, the host reconstructs
from that predecessor snapshot, deterministically re-evaluates the same event,
observes the existing Kernel result, and continues the original receipt or
Run-State compare-and-swap. A retry-budget store also retains signed evidence
indexed by Kernel receipt digest; an exact committed-but-unacknowledged retry is
read back and reused without incrementing the counter or ledger a second time.

Audit batches use the existing closed hash-chained `AuditEvent` and fixed-label
`MetricRecord` contracts for stage start/complete/block, binding, lifecycle,
attempt, artifact, reservation, model/tool/token/cost usage, selection
request/accept/refusal/staleness/reconciliation, fixed and selected resolution,
dispatch start/completion, direct-unbound refusal, Project bootstrap
plan/confirmation/apply/readback, retry, refusal, projection,
draft-PR/current-head, human action, reconciliation, and recovery records. They
contain bounded counters and digests, not raw prompts,
identities, paths, credentials, or target names.

## Security control coverage

The runtime rejects binding-domain swaps, copied Kernel receipts, legacy
authorization records, candidate or signature forgery, cross-demo evidence,
stale generations, forked fence chains, concurrent fence losers, unknown
provider usage, and projection advancement without Kernel evidence. Tests also
cover post-await revocation, ambiguous claims and writes, Kernel-first
persistence, same-core projection metadata, pause/block/cancel/retry and
backward repair, and a real `evaluateTransition()` to bridge and Single Writer
path. Live stores, credentials, paid providers, and Project mutation remain
undeployed prerequisites.

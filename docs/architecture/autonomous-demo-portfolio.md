# Autonomous demo portfolio foundation

## Status

The exact four-demo contract, runtime registration, convergence validation,
redacted observability, hermetic simulation, and executable hardening evidence
are integrated. It defines no live Project, credential, paid inference, or
autonomous administrative effect. The domain-neutral lifecycle and Control
Kernel are unchanged.

## Authority boundary

The portfolio is subordinate to the existing order:

1. lifecycle graph;
2. Work Accord and Phase Contracts;
3. policy compiler and Capability Registry;
4. Control Kernel;
5. trusted adapter;
6. Single Writer; and
7. model output.

The catalog, journey overlay, activation profile, run state, fence, artifact,
receipt, projection, and decision contracts narrow and record this authority.
They do not choose a repository, route, capability, credential, retry, effect,
approval, or merge.

## Canonical catalog and journeys

The catalog is closed to four entries in this order:

| Demo | Canonical journey stages | Reserved model stages |
|---|---:|---|
| App Modernization | 10 | Current-state inventory, Modernization assessment, Target architecture, Implementation, Verification |
| Feature Delivery | 9 | Requirements clarification, Codebase discovery, Solution design, Build, Test and verification |
| Security and Dependency Remediation | 9 | Triage, Reproduction and impact analysis, Remediation design, Patch implementation, Security verification |
| Adaptive Delivery | 9 | Context inventory, three Discovery Studio candidates, Guided synthesis, two Implementation Studio candidates, Test and verification |

Intake and repository discovery are deterministic where declared. Migration
plan, implementation plan, and patch planning are planning stages. Human review
and Completed remain human and terminal stages. Each demo also reserves
Activation Pending, Paused, Blocked, and Cancelled as Kernel-owned control
conditions. Every non-model reservation has an explicit empty runtime binding.

## Contracts

| Contract | Purpose |
|---|---|
| `DemoCatalog@1.0.0` | Exact four-entry portfolio and reserved document locations |
| `DemoIdentityReservationManifest@1.0.0` | Complete stage map and globally exclusive model runtime identities |
| `DemoProjectProfile@1.0.0` | Trusted Project/repository/Work Accord binding inputs and per-demo references |
| `DemoJourneyDefinition@1.0.0` | Ordered displayed stages mapped onto unchanged lifecycle states |
| `StageAgentBindingSet@2.0.0` | Explicit participation policy and exact fixed or selectable runtime candidates |
| `AgentParticipationPolicy@1.0.0` | Enterprise ceiling and per-project locked, guided, or flexible narrowing |
| `SignedStageAgentSelectionGrant@1.0.0` | One authenticated exact-agent grant for one Project item and run generation |
| `DemoCapabilityRegistryShard@1.0.0` | Full per-demo capability definitions without shared-registry edits |
| `DemoActivationProfile@1.0.0` | Expiring, revocable, fixed-budget pre-authorization inputs |
| `DemoRunState@1.0.0` | Content-addressed core/journey cursor, generation, run/attempt, fence base, and nullable trusted draft-PR identity |
| `DemoRunFence@1.0.0` | One repository-ID/work-item-node concurrency domain across workflows |
| `StageArtifactEnvelope@1.0.0` | Producer- and run-bound artifact metadata and content digest |
| `SignedStageReceipt@1.0.0` | Signed stage completion and exact Kernel continuity evidence |
| `DemoProjectionMapping@1.0.0` | Fourteen display projections with Kernel Stage written last |
| dispatcher/scheduler decision and refusal contracts | Closed conventional-code decisions with no success-shaped fallback |

The content digest covers API version, kind, schema version, and specification.
Signatures are outside that digest envelope and sign the resulting digest.
Strict JSON ingestion rejects decoded duplicate keys before schema validation.
Validated contracts are canonical immutable snapshots.

Runtime-local `DemoBudgetState` and `DemoProjectionState` observations are also
closed, content-addressed, bounded, duplicate-key-safe at JSON ingestion, and
immutable after validation. Reconstruction requires the exact Kernel snapshot
and receipt head, Work Accord binding, authority epoch, generation, fixed lease
and budget, complete stage receipt/artifact history, one linear fence chain,
and a projection that does not lead Kernel.

## Receipt-backed journey overlay

Multiple displayed stages may occupy one lifecycle state. A signed stage receipt
advances exactly one ordinal and binds the current run-state digest, authority
epoch, generation, run/attempt, predecessor stage receipt, required
producer-bound artifact, and complete before/after Kernel bindings. A model
stage also binds the acquired and released per-item run-fence records before
the journey cursor can advance.

- **Same core state:** no applied Kernel result is accepted; core state,
  state version, authority digests, Kernel snapshot digest, and receipt head
  must remain identical.
- **Different core state:** the caller supplies the exact `applied` Kernel result.
  Its route and receipt must match the source/destination states, previous
  receipt head, contiguous state version, source authority, Work Accord,
  effect-plan digest, processed-event evidence, destination snapshot, and
  signed stage receipt.

Project fields, model text, and stage artifacts cannot advance either layer.

## Dispatch, scheduling, and activation

The pure dispatcher derives the first incomplete canonical stage from the
verified receipt prefix. Fixed stages use one reviewed non-user-invocable
binding. Selectable stages require a signed exact-agent grant created by
`resolveStageAgentSelection()` from authenticated Project intent and the
intersection of enterprise/project policy, Work Accord, Phase Contract,
Capability Registry, Activation Lease, actor authorization, current bindings,
run generation, receipt head, current PR head, and budget. It emits one closed
action and never accepts a stage, route, agent, capability, target, or effect
from model output. Missing or invalid selection has no fallback. A stage artifact
that crosses a core-state boundary selects the unique lifecycle route by its
declared source and destination; `evaluateTransition()` remains the only
transition evaluator.

The scheduler accepts only a signed, durably re-read dispatcher decision. Model
work requires an exact current activation claim, a rechecked global stage
binding, one cross-workflow compare-and-swap fence, and a conservative signed
cost reservation. It rechecks lease, budget, generation, and binding after the
awaited durable writes and immediately before inference. Provider usage is
authenticated and settled; unknown usage remains held. No provider, target,
agent, or capability substitution exists.

Activation accepts only the reviewed catalog/profile/binding tuple, exact issue
form source, allowed numeric submitter, explicit named consent, current
revocation generation, signed fixed lease, empty initial budget, and one
durable claim. Missing or ambiguous prerequisites return no inference or write
authority.

## Sharded registration

Each catalog entry reserves:

```text
config/v1alpha1/demo-projects/<demo>/capabilities.json
config/v1alpha1/demo-projects/<demo>/runtime-bindings.json
```

All four shard pairs are now installed. Each pair implements exactly its
reserved model capabilities and every stage entry, retains empty bindings for
non-model stages, avoids base/global identity collisions, and binds the exact
catalog and identity-manifest digests. Validation still supports zero or one
complete shard pair for isolated contract development, but a partial pair is
always invalid and portfolio validation requires all four.

## Project projection vocabulary

The exact Project field names are:

1. Stage
2. Journey Stage
3. Demo Project Profile
4. Depth Profile
5. Gate Status
6. Contract Revision
7. Last Receipt
8. Attention
9. Target Repository
10. Run / Attempt
11. Current Draft PR
12. Current Stage Agent
13. Stage Interaction
14. Requested Stage Agent
15. Agent Selection Status

Requested Stage Agent is the sole human-editable input field and is excluded
from the projection mapping. Target Repository is display-only and never feeds
Trusted Binding. Stage derives from the Kernel snapshot. Journey Stage, Stage
Interaction, Current Stage Agent, and Agent Selection Status derive from trusted
state. Convergence writes the fourteen projection fields with Stage last.

Every single-select option also carries one explicit supported GitHub color.
Colors are presentation metadata only; option names and descriptions remain the
accessible semantic source. Color is excluded from lifecycle, Work Accord,
policy, capability, target, credential, transition, agent-selection, effect,
approval, and merge decisions. The target manifest binds each Project schema
digest, while setup bindings and bootstrap readback retain exact option names,
colors, descriptions, and node IDs. Missing or drifted color data blocks binding
or requires human-admin reconciliation rather than defaulting to gray.

Existing populated display Projects use a separate display-only reconciliation
contract. It binds exact snapshot-derived owner/repository/Project/view and
field/option identities plus current schema digests, requires independent
manifest and plan confirmation, and can emit only human-admin option-color
changes. It records view layout/order without treating either as color authority
and explicitly cannot produce installation, credential, effect, activation, or
runtime-binding data. The stricter customer bootstrap and runtime binding
requirements are unchanged.

Each field write uses expected-state compare-and-swap plus read-after-write
verification. A lost acknowledgement is reconciled only when two stable reads
prove the exact intended state. A projection with a newer Kernel state version,
an unrelated receipt, or a same-version receipt-head mismatch is never
overwritten automatically. Same-core progress still performs the final Stage
write so the new stage-receipt metadata is committed and verified last.

## Workflow validation

Trusted metadata assigns one of three existing control classes:
framing comment, target-free execution, or current-head COMMENT review. The
class is never read from the workflow as authority. Validators require a total
one-to-one source mapping and preserve default-branch guards, pinned
`gh-aw`/Copilot controls, exact tools and skills, staged safe outputs, disabled
implicit issue fallbacks, no PAT/network/external-MCP access, and no approval or
merge path. Demo workflows use the existing action set.

## Integrated validation and simulation

`validate:demos` requires all four complete contract sets, all reserved assets,
23 exclusive runtime candidates, exact source/lock pairs, Phase Contract
closure, fixed command catalogs, recovery fixtures, and the reviewed action
lock. `simulate:demos` exercises the actual Kernel-subordinate runtime seams
with injected hermetic services and emits byte-deterministic canonical
JSON/NDJSON. See [portfolio simulation](../demos/portfolio/simulation.md).

`validate:hardening` validates the closed hardening plan, runs every referenced
actual boundary test without skips or todos, runs the real simulator twice,
requires byte-identical output and all 96 pre-inference/pre-effect
cross-demo refusals, and emits canonical all-demo scenario and fault-boundary
evidence with closed zero-valued fixture-declared external-call assertions. The
plan is evidence selection, not authority or runtime telemetry. See
[ADR 0011](../adr/0011-hermetic-readiness-is-not-live-activation.md).

Repository integration does not provision Projects. Live visibility and use
remain blocked through the follow-on human-admin work described in
[portfolio setup](../demos/portfolio/setup.md) and the
[activation and readiness runbook](../demos/portfolio/activation-and-readiness.md).

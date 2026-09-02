# Control Kernel implementation

## Status

**Current through portfolio integration and hardening.** The kernel remains a
pure, deterministic TypeScript library with no GitHub client, credential access,
filesystem mutation, network operation, model invocation, or effect executor.
The engineering and demo simulators compose it with separately injected local
and fake services; they do not move those effects into the kernel.

## Implemented boundary

- `schemas/v1alpha1/` contains closed JSON Schemas for lifecycle graphs, Work Accords, Phase Contracts, Capability Registries, compiled policy, snapshots, events, Authority Rebind bundles, human-gate and contract-requirement evidence, leases, and transition receipts.
- `config/v1alpha1/` contains the reviewed lifecycle, deny-by-default registry,
  policy, and framing, planning, execution, verification, and human-review Phase
  Contracts.
- `src/kernel.ts` evaluates one immutable snapshot and one validated event into an applied transition, idempotent no-op, or typed refusal.
- `src/policy.ts` intersects enterprise, Work Accord, Phase Contract, Domain Pack constraint input, and registry ceilings. It retains actor classes, gates, read scopes, tool/network declarations, risk/privacy constraints, limits, provenance evidence, and evaluations in each compiled grant. Inputs may only narrow authority.
- `src/authorization.ts` enforces current actor classes/roles, human identity, independence, exact Accord binding, and current-head gates.
- `src/receipts.ts` verifies deterministic receipt-chain, phase-authority, and authority-rebind continuity against a caller-supplied trusted terminal head.
- `src/migrations.ts` provides a deterministic, non-mutating migration registry and planner. The initial supported Control Kernel format is `1.0.0`; no earlier released format exists. Same-version dry runs validate complete documents and return unchanged clones. Unknown versions and unregistered paths return `MIGRATION_UNAVAILABLE`; malformed documents return `SCHEMA_INVALID`. Future migrations must register unique steps with explicit source and target validators, and migration implementations are checked for deterministic output and input immutability.
- `src/work-accord-markdown.ts` renders an informational human view that explicitly grants no authority.

## Deterministic inputs and outputs

The kernel validates every runtime boundary and consumes trusted-bound values. Before route selection it computes the canonical Work Accord target-binding digest from `repositoryId`, `workItemNodeId`, and immutable `sourceDigest`, then requires that exact digest in the Work Accord context, snapshot, and event provenance. Mutable `currentHead` remains separately bound. It also hashes the supplied lifecycle graph and compares the exact digest with both the snapshot and Work Accord. Snapshot validation derives the state's phase owner from that graph and requires exact current Phase Contract and compiled-policy authority in every state except the explicitly enumerated pre-activation/control states that require null authority. Date-time inputs use canonical UTC `Z` syntax and real Gregorian calendar validation. An event carries immutable identity, monotonic sequence, compare-and-swap state version, actor authorization evidence digest, Trusted Binding digest, payload digest, occurrence time, and declared resource cost.

For a phase change, the kernel recompiles source authority and an explicitly supplied destination Phase Contract. The Work Accord binds exact Domain Pack and Capability Registry digests, and the destination contract must have the exact Work Accord reference and digest and bind the exact lifecycle graph. Source exit rules and destination entry predicates/evidence requirements are checked against closed evaluation records bound to the current snapshot, phase contract, route, Work Accord, Trusted Binding, head, actor when applicable, and exact Activation Lease when applicable; unknown requirement names fail closed. Human gates are route-specific: activation, frame acceptance, plan acceptance, and current-head approval cannot substitute for one another, while an in-phase revision does not require a future artifact approval. The next snapshot and receipt install the destination Phase Contract and compiled-policy digests atomically; a stale or substituted destination cannot inherit source authority. Lifetime Work Accord/lease usage remains cumulative while phase-local usage resets at the handoff.

The active contract phases are fixed in conventional code to framing, planning, execution, verification, and human review. Every route into one of those phases, including zero-cost planning/review entry, resume, retry, and recovery routes, requires a current non-revoked Activation Lease. Lease authorization always verifies the exact Work Accord, approving-human evidence, destination phase, compiled capabilities, expiry, and parallel limit. Model-backed, budget-consuming, tool, shell, network, and MCP capabilities are forbidden in non-cost-bearing planning and human-review phases; invocation-capable grants therefore remain tied to cost-bearing routes. Kernel-owned activation-pending, pause, block, completion, cancellation, and reauthorization destinations do not require a destination lease. Intake is initial-only: no route may re-enter `CAPTURED`, no intake Phase Contract or capability grant is valid, and `enter-phase` is emitted only for the fixed active set.

After authorization is invalidated, a trusted adapter/system or policy-engine/policy event may rebind an `ACTIVATION_PENDING` snapshot to a linearly superseding Work Accord for the same repository/work-item binding. The versioned closed Authority Rebind wrapper is detached and checked for canonical JSON values before schema traversal or hashing; malformed values, functions, accessors, extra fields, and cycles fail closed. The event binds the canonical digest of the complete replacement authority bundle, so its identity, idempotency key, and receipt cannot be reused with different destination authority. The kernel schema-validates and recompiles the replacement graph, policy, registry, Domain Pack, and Phase Contract set, then atomically records source and destination authority digests in the receipt. Projected post-event lifetime usage is checked against the replacement Accord before installation. Lifetime usage, processed-event history, sequence, state version, and receipt-chain history are preserved. Authenticating and durably anchoring that trusted input remains a trusted-adapter and deployment responsibility.

The result is one of:

- `applied`, with the next immutable snapshot, route, hash-chained receipt, and target-free effect requests;
- `noop`, for an exact duplicate event whose recorded receipt also supplies the effect idempotency key; or
- `refused`, with a stable code, rule ID, retry classification, and recovery class.

The effect union can request receipt emission, phase entry, reconciliation, or human action. It cannot name a repository, branch, issue, pull request, Project field, network destination, shell command, or GitHub mutation.

## Fail-closed behavior

The evaluator refuses unknown or ambiguous routes, graph-declared state ownership/cost/terminal flags that disagree with kernel invariants, routes into the initial-only `CAPTURED` state, routes out of `COMPLETED` or `CANCELLED`, missing active authority, stale graph/contract/policy/current-head digests, forged provenance, replay conflicts, reordered input, stale state versions, unauthorized or non-independent actors, missing/stale/expired gates or contract requirements, absent/revoked/expired leases, unauthorized phases/capabilities, unsafe integer arithmetic, exhausted lifetime or phase-local budgets, unclassified retries, and exhausted route/loop/retry limits.

Pause records its deterministic resume state. Blocking records its deterministic recovery state. Partial effects always enter `BLOCKED` and request reconciliation; they never advance optimistically.

## Unsupported boundary

The kernel does not establish that an external actor, review, head SHA, event,
lease, or terminal receipt-head digest is genuine. Those facts come from the
trusted adapter using fresh authenticated reads. Receipt signatures and durable
persistence anchors remain adapter/deployment responsibilities. The kernel does
not execute or persist effects, mint tokens, invoke models or tools, mutate
Projects, approve or merge pull requests, deploy, publish, or change
production/external systems.

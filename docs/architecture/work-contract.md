# Work Accord and Phase Contract

## Status

**Current through portfolio hardening.** Closed runtime schemas exist for Work
Accords, Phase Contracts, compiled policies, Activation Leases, snapshots, and
receipts, with TypeScript models, validation, policy compilation, and a
deterministic human-readable Work Accord renderer. Trusted GitHub binding,
state publication, activation, and durable evidence are implemented as injected
interfaces and hermetic tests; their live services remain undeployed.

## Work Accord

A Work Accord is the versioned contract for one GitHub work item. It records requested outcomes and constraints but grants no authority by itself.

Required sections:

- schema version, stable ID, revision, previous digest, and creation provenance;
- Trusted Binding digest and authoritative issue/PR identities;
- objective, requested outcome, in-scope and out-of-scope work;
- assumptions, dependencies, prohibited effects, and allowed repositories/paths;
- privacy and data-handling class;
- exact lifecycle graph, Domain Pack, Capability Registry, and Phase Contract digests plus their reviewed references and Depth Profile;
- requested capabilities and risk class;
- tool, network, MCP, secret, and external-side-effect constraints;
- call, token, cost, duration, retry, loop, decomposition, concurrency, and patch-size limits;
- deliverables, acceptance evidence, verification commands, and approver policy;
- branch, PR, current-head, expiry, cancellation, recovery, and retention policy;
- source event, activating human, review evidence, and acceptance provenance.

Material changes produce a new revision, invalidate stale outputs, and require a new Activation Lease.

The repository includes a validated JSON example at `examples/v1alpha1/work-accord.json`. The following YAML remains illustrative:

```yaml
apiVersion: agentic-framework.github.com/v1alpha1
kind: WorkAccord
identity:
  id: issue-123-r2
  revision: 2
  supersedes: issue-123-r1
binding:
  repositoryId: 42
  issueNodeId: I_example
  observedUpdatedAt: 2026-08-25T20:11:12Z
  sourceDigest: sha256:example
objective:
  outcome: Produce a reviewable repository artifact.
  inScope:
    - docs/**
  outOfScope:
    - external publication
policy:
  domainPack: engineering/v1
  depthProfile: D2
  prohibitedEffects:
    - merge
    - deploy
budget:
  maxCalls: 4
  maxParallel: 2
  expiresAt: 2026-08-26T20:11:12Z
evidence:
  required:
    - type: check-run
      selector: contract/verification
humanGates:
  - activate
  - accept-plan
  - approve-current-head
```

Writable status fields such as `approved`, `done`, or `archiveReady` are prohibited. They are computed from current GitHub evidence.

## Trusted Binding

Trusted Binding is derived from the triggering event and fresh API reads. It contains immutable numeric/node identities, repository and installation IDs, issue/PR identity, approved base, current head, Project item, policy digest, and contract revision. User/model text cannot supply or override it.

`workAccordBindingDigest()` is the sole canonical adapter contract for the
implemented target identity. It hashes an explicitly reconstructed object
containing only `repositoryId`, `workItemNodeId`, and immutable `sourceDigest`;
JSON property order cannot alter the digest, and mutable `currentHead` is bound
separately. Initial snapshots, events, rebinds, and receipts must all use this
function rather than caller-assembled subsets. Any future released migration
must preserve or explicitly re-establish this binding from authenticated source
artifacts.

## Activation Lease

An Activation Lease binds:

- approving human identity and current authorization evidence;
- Work Accord digest;
- provider/model allowlist;
- maximum calls, tokens, cost units, duration, and parallelism;
- allowed phases and capabilities;
- expiry and revocation conditions.

Activation gate and contract-requirement evidence must bind the exact lease digest; evidence for one lease cannot approve a substituted lease. Every active-phase entry, resume, retry, or recovery validates lease phase/capability authority even when the route consumes no calls or cost units. Kernel-owned control destinations require no destination lease. Model, tool, shell, network, and MCP capabilities cannot compile into non-cost-bearing phases; invocation-capable grants remain coupled to cost-bearing transitions and lease budgets.

## Phase Contract

A Phase Contract defines an approved active lifecycle phase's entry, output, evidence, budget, and deterministic exit rules. The active set is fixed to framing, planning, execution, verification, and human review; intake and kernel-owned control states cannot have Phase Contracts or capability grants. A contract binds an exact lifecycle graph digest, references capabilities by immutable ID/version, and names the typed output adapter. Its input and output schemas use the supported closed schema dialect, and model-facing output properties are restricted to the target-free vocabulary. It cannot create an undeclared effect. Cross-phase transitions mechanically enforce the source exit rule and destination entry/evidence requirements, require the exact destination contract from the Work Accord, reset phase-local usage, and install compiled destination authority atomically. Unknown requirement names fail closed.

## Validation rules

- Unknown fields and versions fail closed; canonical date-times must use UTC `Z` and represent a real calendar instant.
- Model-facing schemas use a conservative closed dialect; combinators, open objects, and target/control aliases are forbidden.
- Requirement evaluations bind the current snapshot, route, Phase Contract, Work Accord, Trusted Binding, current head, exact Activation Lease when applicable, actor authorization when applicable, observation time, and expiry; a stale record cannot shadow a later valid record.
- Repository/path scope may narrow but not exceed policy.
- Missing evidence, reviewer authorization, current-head binding, or threat success blocks effects.
- `adapted` or `verbatim` third-party content requires a complete provenance disposition and human/legal approval.
- Contracts never bypass rulesets, required checks, CODEOWNERS, or independent review.

## Storage and evidence

The current kernel produces typed, schema-validated hash-chained receipt values
and verifies them against an externally supplied trusted terminal head. Receipts
bind both source and destination authority so an authorized Work Accord rebind
can continue the same chain without discarding usage or replay history. The
kernel does not persist or cryptographically sign the trusted terminal head.
Contract-requirement and rebind inputs are trusted inputs to this pure kernel;
the GitHub adapter interfaces establish their authenticity and freshness from
authoritative reads. Live signatures, protected persistence, and durable
service deployment remain external prerequisites. Any cache must be rebuildable
and non-authoritative.

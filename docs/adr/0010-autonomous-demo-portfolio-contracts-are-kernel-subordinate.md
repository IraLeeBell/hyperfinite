# ADR 0010: Autonomous demo portfolio contracts are Kernel-subordinate

- **Status:** Accepted three-demo baseline; portfolio cardinality and participation contracts superseded by [ADR 0012](0012-user-selected-agents-are-bounded-human-intent.md)
- **Date:** 2026-08-29

## Context

Three demonstrations need distinct displayed journeys and stage-local agents
without changing the domain-neutral lifecycle or creating a second transition
authority. Shared registries would force parallel demo changes through one file
and could permit an agent, capability, or workflow to be reused across stages.
GitHub Project fields are useful presentation but are not authority.

## Decision

The portfolio uses a closed, canonical `DemoCatalog@1.0.0` with exactly App
Modernization, Feature Delivery, and Security and Dependency Remediation in
that order. A content-addressed identity manifest reserves every canonical
journey stage and the shared Activation Pending, Paused, Blocked, and Cancelled
control conditions. Each model stage has one globally exclusive
`(demoProjectId, stageId, agentId, capabilityId, workflowId)` binding.
Deterministic, planning, human, Kernel, and terminal stages carry an explicit
empty binding set. Existing `runtime-*` agents remain generic templates and
cannot satisfy a portfolio reservation.

The Kernel's closed requirement vocabulary includes the two reserved
independent-human completion predicates used by Feature Delivery and Security
and Dependency Remediation. They consume exact-current-head actor-bound
requirement evidence and do not add a route or automate approval.

The same closed vocabulary enumerates every pack Phase Contract entry, exit,
and evidence requirement. Supporting those fixed names does not make free-form
requirements valid; unknown names still fail closed.

Closed-schema model-output vocabulary checks apply only when a Phase Contract
grants a model capability. Human-only Phase Contracts may use their closed
human evidence schema without turning those fields into model output.
Model-capable pack schemas may use only the explicitly reviewed digest,
fixed-status, acceptance-ID, target-free change, and COMMENT fields. Closed
`anyOf` branches are permitted; ambiguous or open branches remain invalid.

Every portfolio contract is recursively closed, versioned, canonical-JSON
content-addressed, duplicate-key-safe at file ingestion, and returned as an
immutable snapshot. Per-demo capability and runtime-binding shards live under
the reserved demo directory. A complete shard pair is checked against the
central reservation manifest, while entirely absent demos remain valid so
each downstream demo pull request can validate independently.

Displayed journey stages are a receipt-backed overlay on the existing lifecycle.
A signed stage receipt may advance between stages mapped to the same core state
only when Kernel state, version, authority, snapshot digest, and receipt head
remain unchanged. A cross-state advance requires the exact applied Kernel
result, its schema-valid hash-chained receipt, and the resulting Kernel snapshot.
The overlay never selects a route or modifies Kernel output.

The shared Project vocabulary is Stage, Journey Stage, Demo Project Profile,
Depth Profile, Gate Status, Contract Revision, Last Receipt, Attention, Target
Repository, Run / Attempt, Current Draft PR, and Current Stage Agent. Every
field is a projection. Target Repository is display-only, Journey Stage and
Current Stage Agent derive from verified stage evidence, and Kernel Stage is
written last during convergence.

Each demo has one static issue form and one declarative Project schema. Trusted
code binds the form filename to the exact Foundation catalog entry, profile
reference, and schema digest. Form values are bounded untrusted data; the
repository value is only a hint. Consent acknowledges the already reviewed
fixed budget but cannot grant repository, Project, capability, credential,
transition, route, or effect authority. Deterministic preflight blocks missing
consent, disabled activation, unauthorized submitters, unresolved repository
bindings, stale Project bindings, malformed or oversized content, and missing
budgets before credentials, reservation, or inference. Missing information is
represented by one typed, submission-digest-bound blocked artifact rather than
natural-language heuristics or automatic issue creation.

Runtime and workflow validators classify a workflow only from trusted core or
per-demo binding metadata. Every source must have exactly one trusted binding,
and every trusted binding must have a source. A workflow cannot self-select a
weaker validation class. Existing default-branch execution, exact tools and
skills, staged outputs, COMMENT-only review, no fallback, pinned toolchain,
and deny-by-default access controls remain unchanged.

Exact-head review materialization uses a closed signed
`DemoReviewEvidenceBundle@1.0.0`. It binds one validated verification-stage
runtime identity, complete per-pack fixed command/check evidence, one open
draft pull-request base and head, bounded diff digests, `COMMENT`-only output,
and explicit head-movement invalidation. Repository, Project, pull-request,
contract, and complete diff fields derive from two stable fresh reads rather
than caller assertions and bind the exact registered repository-binding
digest. Canonical target identities enter an opaque registration only through
fresh signed trusted-adapter evidence bound to the profile, repository, and
Project digests. The opaque registration retains that evidence expiry and
rechecks it at registration and review-bundle consumption; a review bundle
cannot expire later than its target evidence. It grants no effect authority.
Non-Git verification
commands require a separately isolated credentialless runner; the privileged
bridge fails them closed.

COMMENT application requires an API-port precondition over the complete fresh
execution state, binding, plan, effect, and expected head. The trusted adapter
must enforce that precondition atomically with the COMMENT mutation.

## Consequences

- The lifecycle graph and transition schemas remain byte-identical. The Kernel
  evaluator recognizes the fixed pack requirement vocabulary, and the policy
  schema dialect recognizes closed `anyOf` plus reviewed target-free evidence
  fields; unknown names and open schemas still fail closed.
- Each demo can maintain one complete shard without editing a shared capability
  or runtime-binding array.
- Same-state journey progress has explicit signed replay evidence without
  incrementing Kernel state.
- Cross-demo substitution and generic-agent fallback fail before inference.
- Project drift can trigger reconciliation but never advancement.
- Project and issue-form catalogs remain offline declarations; every setup or
  drift action requires a human administrator.
- Review agents receive one authenticated bounded evidence bundle rather than
  raw repository authority or model-selected commands.
- Demo agents, workflows, runtime artifacts, activation, dispatch, and
  scheduling now compose through the reviewed per-demo shards. Live effects and
  Project provisioning remain downstream human/deployment work; declarative
  Project UX does not activate them.

## Rejected alternatives

- Add demo states or routes to the lifecycle: rejected because presentation is
  not lifecycle authority.
- Reuse generic phase agents across demo stages: rejected because it defeats
  stage identity isolation.
- Let workflow frontmatter declare its validation class: rejected because
  untrusted source could select weaker controls.
- Require all three shards simultaneously: rejected because it defeats the
  reviewed parallel delivery graph.
- Treat Project field movement as a stage receipt: rejected because Projects
  are non-authoritative projections.

## References

- [Autonomous demo portfolio architecture](../architecture/autonomous-demo-portfolio.md)
- [Deterministic mechanical authority](0002-deterministic-mechanical-authority.md)
- [Target-free model outputs](0004-target-free-model-outputs.md)
- [Threat model](../security/threat-model.md)

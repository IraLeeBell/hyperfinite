# Architecture

Hyperfinite separates deterministic authority from untrusted advisory
computation. Read the pages in this order for a complete system view:

1. [Overview](overview.md) — product/technical identity, trust zones, two-plane
   model, durable evidence, replay, and current implementation boundary.
2. [Distribution boundary](distribution-boundary.md) — supported repository and
   customer-starter entry points plus unsupported package, SDK, CLI, hosted,
   deployment, and live-effect paths.
3. [Lifecycle](lifecycle.md) — domain-neutral states, routes, gates, and failure
   behavior.
4. [Work Accord and Phase Contract](work-contract.md) — versioned work scope,
   policy bindings, leases, evidence, and active-phase contracts.
5. [Capability Registry](capability-registry.md) — deny-by-default capability
   declarations and monotone policy narrowing.
6. [Control Kernel](control-kernel.md) — pure transition evaluation, receipts,
   refusals, reauthorization, and unsupported effects.
7. [GitHub adapter](github-adapter.md) — event verification, Trusted Binding,
   target translation, credentials, and Single Writer.
8. [Autonomous demo portfolio](autonomous-demo-portfolio.md) — exact catalog,
   journey overlay, stage identities, registration, and simulation.
9. [Domain Packs](domain-packs.md) — repository-only Engineering, Marketing, and
   Business Operations specialization.
10. [Engineering reference slice](thin-slice-plan.md) — complete hermetic
   issue-to-human-review and closure path.
11. [Packaging and replication](packaging-and-replication.md) — target-bound
    installation planning, migration, rollback, and release evidence.
12. [Durable stores](durable-stores.md) — the nonproduction local trust-store
    substrate, its cross-process guarantees, and its refusal behaviour.
13. [Synthetic sandbox canary](../runbooks/synthetic-sandbox-canary.md) — the
    credentialless composition proof and its Human Review stop.
14. [Administrator handoff](administrator-handoff.md) — digest-bound source
    contracts, exact per-operation human gates, drift-prone readback, and
    readiness separation.

The lifecycle graph remains the top mechanical authority. Demo journeys,
Projects, model outputs, and generated artifacts cannot select or replace a
Kernel route.

For decisions behind the architecture, see [ADRs](../adr/README.md). For live
boundaries and residual risk, see [Security](../security/README.md) and
[Activation and readiness](../demos/portfolio/activation-and-readiness.md).

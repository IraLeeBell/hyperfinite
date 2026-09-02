# Architecture

Hyperfinite separates deterministic authority from untrusted advisory
computation. Read the pages in this order for a complete system view:

1. [Overview](overview.md) — trust zones, two-plane model, durable evidence,
   replay, and current implementation boundary.
2. [Lifecycle](lifecycle.md) — domain-neutral states, routes, gates, and failure
   behavior.
3. [Work Accord and Phase Contract](work-contract.md) — versioned work scope,
   policy bindings, leases, evidence, and active-phase contracts.
4. [Capability Registry](capability-registry.md) — deny-by-default capability
   declarations and monotone policy narrowing.
5. [Control Kernel](control-kernel.md) — pure transition evaluation, receipts,
   refusals, reauthorization, and unsupported effects.
6. [GitHub adapter](github-adapter.md) — event verification, Trusted Binding,
   target translation, credentials, and Single Writer.
7. [Autonomous demo portfolio](autonomous-demo-portfolio.md) — exact catalog,
   journey overlay, stage identities, registration, and simulation.
8. [Domain Packs](domain-packs.md) — repository-only Engineering, Marketing, and
   Business Operations specialization.
9. [Engineering reference slice](thin-slice-plan.md) — complete hermetic
   issue-to-human-review and closure path.
10. [Packaging and replication](packaging-and-replication.md) — target-bound
    installation planning, migration, rollback, and release evidence.
11. [Durable stores](durable-stores.md) — the nonproduction local trust-store
    substrate, its cross-process guarantees, and its refusal behaviour.
12. [Synthetic sandbox canary](../runbooks/synthetic-sandbox-canary.md) — the
    credentialless composition proof and its Human Review stop.
13. [Administrator handoff](administrator-handoff.md) — digest-bound source
    contracts, exact per-operation human gates, drift-prone readback, and
    readiness separation.

The lifecycle graph remains the top mechanical authority. Demo journeys,
Projects, model outputs, and generated artifacts cannot select or replace a
Kernel route.

For decisions behind the architecture, see [ADRs](../adr/README.md). For live
boundaries and residual risk, see [Security](../security/README.md) and
[Activation and readiness](../demos/portfolio/activation-and-readiness.md).

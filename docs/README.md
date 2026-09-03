# Documentation

This directory is the canonical narrative documentation for Hyperfinite.
Documentation describes implemented repository behavior and explicit deployment
prerequisites; it does not grant authority or substitute for live evidence.

## Start here

| Reader | Recommended path |
|---|---|
| Executive sponsor | [Executive summary](../README.md#executive-summary) → [Customer FAQ](../CUSTOMER_FAQ.md) → [Evaluation guide](../CUSTOMER_EVALUATION_GUIDE.md) |
| Evaluation lead | [Evaluation guide](../CUSTOMER_EVALUATION_GUIDE.md) → [Approval tickets](runbooks/customer-approval-tickets.md) → [Customer administrator](runbooks/customer-administrator.md) |
| Architecture reviewer | [Architecture overview](architecture/overview.md) → [Lifecycle](architecture/lifecycle.md) → [Control Kernel](architecture/control-kernel.md) |
| Demo operator | [Demo portfolio](demos/README.md) → [Operator runbook](demos/portfolio/operator-runbook.md) → [Simulation](demos/portfolio/simulation.md) |
| Customer administrator | [Customer administrator](runbooks/customer-administrator.md) → [Project setup](runbooks/github-project-setup.md) → [Deployment prerequisites](runbooks/deployment-prerequisites.md) → [Administrator handoff](runbooks/administrator-handoff.md) |
| Security reviewer | [Threat model](security/threat-model.md) → [Control matrix](security/control-matrix.md) → [Secrets and identity](security/secrets-and-identity.md) |
| Operations/support owner | [Observability](runtime/model-observability-and-cost.md) → [Incident response](runbooks/incident-response.md) → [Recovery](runbooks/recovery.md) → [Support](../SUPPORT.md) |
| Contributor | [Contributing](../CONTRIBUTING.md) → [Source map](../src/README.md) → [Tests](../tests/README.md) |
| Release or legal reviewer | [Release evidence](release/README.md) → [Open-source readiness](governance/open-source-readiness.md) → [Reuse policy](provenance/reuse-policy.md) |

## Documentation map

- [Architecture](architecture/README.md): authority, lifecycle, contracts,
  adapters, Domain Packs, packaging, and demo integration.
- [Architecture decisions](adr/README.md): accepted and proposed design
  decisions, with their current status.
- [Demos](demos/README.md): the four demo journeys and portfolio-level
  simulation, observability, setup, and activation guidance.
- [Runtime](runtime/README.md): Copilot/Agentic Workflow controls, demo runtime,
  evidence, cost, and monitoring.
- [Security](security/README.md): threat model, control coverage, credential
  boundaries, GHAS, and administrator permissions.
- [Runbooks](runbooks/README.md): Project planning, activation, deployment,
  customer approvals, incident response, recovery, and installation.
- [Governance](governance/README.md): capability lifecycle and open-source
  readiness.
- [Provenance](provenance/README.md): source inventory and reuse policy.
- [Release](release/README.md): deterministic local evidence and the no-go
  release checklist.
- [Compatibility](compatibility.md): Hyperfinite product/technical identity
  boundary plus tested Node, npm, Git, GitHub CLI, gh-aw, Copilot CLI, and
  platform versions.

## Status language

Documentation uses these terms consistently:

- **Implemented** means code or data exists in this repository and is covered by
  deterministic validation.
- **Hermetic** means exercised with local Git and injected or fake ports; it
  does not imply a deployed network or credential boundary.
- **Disabled by default** means configuration does not authorize live
  invocation or mutation.
- **Undeployed prerequisite** means an interface is implemented but the
  independent service, key custody, conditional store, or administrator
  configuration is absent.
- **Unsupported** means the repository intentionally provides no authority or
  operation for that behavior.

## Documentation rules

1. Preserve the authority order: lifecycle graph, Work Accord and Phase
   Contracts, policy compiler and Capability Registry, Control Kernel, trusted
   adapter, Single Writer, then model output.
2. Describe GitHub Projects as projections, never authority.
3. Distinguish repository evidence from live service evidence and fixture
   assertions from telemetry.
4. Never imply that a model can select a target, route, capability, credential,
   retry, effect, approval, or merge.
5. Link to the authoritative contract or runbook instead of duplicating mutable
   values.
6. Update a changed contract's schema, architecture decision, security control,
   and deterministic tests together.
7. Preserve `LICENSE` byte-for-byte and leave legal or publication decisions to
   authorized humans.

Local Markdown links are expected to resolve within the repository. Generated
Agentic Workflow locks are compiler-owned and are not narrative documentation.

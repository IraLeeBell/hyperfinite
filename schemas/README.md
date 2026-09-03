# Schemas

`schemas/v1alpha1/` defines the closed JSON contracts accepted by the
deterministic control plane. Schemas reject unknown fields and are supplemented
by semantic validators for cross-document digests, canonical order, identity
injectivity, lifecycle ownership, target-free output, and security invariants.

Major groups include:

- lifecycle, Work Accord, Phase Contract, policy, registry, snapshot, event,
  lease, receipt, and human-gate contracts;
- GitHub Project, Trusted Binding, safe-output, Effect Plan, and effect-evidence
  contracts;
- Copilot runtime state and authorization contracts;
- demo catalog, registration, activation, run-state, receipt, projection,
  review-evidence, and hardening contracts;
- Marketing and Business Operations artifact contracts;
- packaging, installation, migration, release, audit, metrics, budgets,
  administrator handoff/apply/readback, and durable grant-store contracts.
- the upstream-only, repository-bound issue-taxonomy reconciliation contract.
- reviewed full-file technical-identity inventory evidence for the repository
  and customer-starter scopes.

Hyperfinite retains `agentic-framework.github.com/v1alpha1` and the
`https://agentic-framework.github.com/schemas/` origin as its technical
compatibility identity. Product display wording does not create a second API
group or schema epoch.

Per-demo artifact schemas live under `v1alpha1/demo-projects/`. Domain Pack
artifact schemas live under `v1alpha1/domain-packs/`.

Do not weaken closure or add a model-facing target/control field to accommodate
an implementation shortcut. Update schemas with their TypeScript types,
validators, architecture decision, security controls, fixtures, and tests. Run
`npm run validate:schemas` and the complete repository matrix.

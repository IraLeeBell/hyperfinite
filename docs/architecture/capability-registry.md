# Capability Registry

## Status

**Current for declaration, validation, and hermetic Domain Pack execution.** A
deny-by-default versioned registry, strict schema, TypeScript model, semantic
validator, phase-scoped resolver, and read-only versus mutating MCP
classification are implemented. Live credentials, network access, MCP access,
and GitHub writes remain disabled.

## Purpose

The Capability Registry is a declarative, reviewed, deny-by-default allowlist. A model cannot create, select, install, broaden, or authorize a capability.

Hyperfinite-owned entries retain the lower-case `agentic-framework` publisher
value as part of the fixed technical compatibility identity. The product name
does not create a second publisher or identifier epoch; repository validation
checks the base registry, every demo shard, and their deterministic generator
against [`compatibility.json`](../../config/v1alpha1/compatibility.json).

## Entry fields

Each immutable version defines:

- fully qualified capability ID, version, publisher, owner, description, and status;
- implementation kind and provider/runner;
- allowed phases, Domain Packs, Depth Profiles, and actor classes;
- typed input schema and target-free output adapter;
- read and write scopes;
- effect class and trust zone;
- GitHub permissions and per-operation token scope;
- target source, which must be Trusted Binding;
- tools, shell commands, network destinations, explicitly classified read-only
  and mutating MCP tools, and secret access;
- privacy/data-handling class;
- call, cost, timeout, retry, output-size, concurrency, and parallel-safety limits;
- human gates;
- idempotency and evidence requirements;
- structural tests, behavioral evaluations, and audit events;
- compatibility, deprecation, replacement, and removal metadata;
- provenance classification and legal/security review state.

## Compilation

Registry compilation rejects:

- unknown IDs or versions;
- malformed JSON Schema keywords or regular expressions;
- open, ambiguous, unsupported, or target-bearing model schemas;
- permissions broader than the route requires;
- wildcard tools, MCP tools, or network destinations;
- missing output adapters, evidence, or budgets;
- unbounded retries or recursive invocation;
- publication, deployment, merge, or production effects;
- adapted/verbatim sources without complete provenance and approval;
- invocation cycles or illegal calls into human-only capabilities.

Planning and human review are non-cost-bearing. Their contracts cannot compile model-backed, budget-consuming, tool, shell, network, or MCP capabilities, preventing a zero-cost route from granting invocation authority.

## Execution

1. Control Kernel selects a route.
2. Accord Compiler intersects enterprise policy, Work Accord, exact Phase Contract binding, Domain Pack, Depth Profile, and registry entry, retaining every stronger capability restriction in the compiled grant.
3. Policy Gate verifies route gates, ensures every compiled gate declaration maps to a lifecycle-enforced gate, and checks actors, leases, and budgets before emitting phase entry.
4. Capability executor receives only the allowed inputs.
5. Model-facing capability returns a typed target-free artifact.
6. Adapter validates it.
7. Control Kernel decides whether any Effect Plan is valid.
8. Single Writer independently obtains a bounded credential and performs the effect.

All eight boundaries are implemented and exercised through injected hermetic
ports, including target-free model output, trusted translation, and Single
Writer checks. Live provider, credential, evidence-store, and GitHub services
remain undeployed and disabled.

## Domain Packs

- **Engineering:** issue, plan, sandboxed implementation, tests, PR, review, delivery evidence. No autonomous merge or deployment.
- **Marketing:** eight closed, evidence- and rights-bound proposal artifacts,
  separate brand/legal gates, and a draft repository package. No CMS, social,
  email, advertising, analytics, or publication adapter exists.
- **Business operations:** nine closed proposal artifacts, explicit
  owner/operator/verifier separation and four-role approval quorum, and a draft
  repository package. No CRM, ERP, ticketing, payment, procurement, or
  production-operation adapter exists.

## Trust reduction

When untrusted issue, PR, repository, web, or MCP content enters a capability context, effective permissions can only remain the same or narrow. Write scopes are never inherited from a prior capability. A human gate does not make untrusted content trusted; it authorizes a specific contract and effect class.

## Update and removal

Registry changes require human-reviewed PRs. New versions are additive. Deprecation names a replacement and migration window. Emergency disablement prevents resolution immediately while preserving evidence. Removal requires no inbound invocation edges and a retained audit record.

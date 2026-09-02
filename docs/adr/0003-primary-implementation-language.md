# ADR 0003: Use strict TypeScript as the primary implementation language

- **Status:** Accepted
- **Date:** 2026-08-25

## Context

The implementation must support a deterministic kernel, runtime schema
validation, GitHub APIs, Actions and CLI integration, Agentic Workflow
artifacts, constrained model adapters, and contributor review. The selected
primary language is strict TypeScript.

## Decision

Use strict TypeScript for the Control Kernel, schemas, GitHub adapter, CLI, and runtime integration.

Required constraints:

- strictest practical compiler settings, including no implicit `any`;
- runtime validation at every untrusted boundary;
- minimal, pinned dependencies and lockfile enforcement;
- pure deterministic kernel separated from adapters and process effects;
- exhaustive state/route handling;
- branded identity types rather than interchangeable strings;
- isolated credentials and short-lived processes;
- property, replay, concurrency, schema-compatibility, fuzz, and integration tests;
- generated artifacts reviewed alongside source;
- supply-chain provenance and release attestations before distribution.

## Decision drivers

- Direct fit with JSON Schema, GitHub Apps, Octokit, Actions, MCP, and agent tooling.
- Faster contributor iteration and a single schema/tooling ecosystem.
- Strong static guarantees when strict mode and exhaustive unions are enforced.
- Straightforward cross-platform CLI distribution through the Node ecosystem.
- Lower integration translation cost across the planned adapters.

## Consequences

- Runtime types do not enforce themselves; schema validation is mandatory.
- Node dependency and package supply chain require aggressive minimization and auditing.
- Process/thread isolation and concurrency need explicit design.
- A TypeScript runtime can be larger and less operationally self-contained than one Go binary.

## Rejected alternative: Go

Go was the strongest alternative. Its advantages include:

- simple single-binary distribution;
- excellent race detection, fuzzing, profiling, and concurrency tooling;
- a smaller typical dependency/runtime surface;
- strong precedent for compilers and locked-artifact tooling;
- clear process and resource behavior.

It was not selected because the expected integration surface is predominantly typed JSON, GitHub App/Actions APIs, MCP, and agent tooling, and the anticipated contributor workflow favors TypeScript. This is a project decision, not a claim that Go is less safe. If TypeScript cannot meet deterministic replay, isolation, supply-chain, or distribution requirements, this ADR must be revisited.

## Security and operational impact

No TypeScript object is trusted merely because it type-checks. Event, API, model, configuration, registry, and persisted evidence inputs are validated at runtime. Model and GitHub adapters cannot import mutation implementations directly.

## Open questions

- Will packaging require a bundled executable?

## References

- [Architecture overview](../architecture/overview.md)
- [Work Accord](../architecture/work-contract.md)
- [Capability Registry](../architecture/capability-registry.md)

# ADR 0020: Supported distribution is repository and customer-starter source only

- **Status:** Accepted
- **Date:** 2026-09-03

## Context

Hyperfinite currently operates as a repository-based reference implementation
and customer-evaluation distribution. Its npm package is private, exports no
runtime API, and has no `bin` entry. The repository contains internal TypeScript
modules and command-oriented scripts, but it does not publish an SDK, install a
general-purpose CLI, host a service, provide a deployable production service, or
bundle the external trust services required for live effects.

Without one explicit boundary, internal barrels can be mistaken for a supported
API, repository scripts for an installed CLI, unsigned local archives for
releases, and interface implementations for deployed services.

## Decision

The supported distribution is reviewed source in two forms:

1. maintainers and local evaluators clone the authoritative repository at an
   exact reviewed head and invoke documented repository `npm` scripts; or
2. customers populate a new private customer-owned repository from either a
   verified customer-starter profile or a reviewed full file-only copy.

A customer-starter profile supports only its documented profile commands and
ends at repository/hermetic evidence. A complete sandbox evaluation uses the
reviewed full file-only copy, then configures ownership, commits, repins,
validates the full matrix, and obtains the documented human and deployment
prerequisites.

`CompatibilityMatrix.productBoundary` fixes those entry points. It also fixes
the following as unsupported: npm registry package consumption, TypeScript SDK
or deep-import consumption, a packaged/general-purpose CLI, a hosted service,
and a deployable service. Repository scripts are supported only in a reviewed
repository context. Live administration remains an external human prerequisite;
live effects remain an independently deployed trust-service prerequisite.

The private package keeps the `agentic-framework` name solely as the retained
technical compatibility identity. Its export map exposes only `package.json`;
SDK entry metadata, direct or `directories.bin` binary entry points, implicit
`server.js` start behavior, implicit `binding.gyp` native builds, and
install/prepare/dependencies/package/publication/deployment/service lifecycle
scripts remain absent. Dependency installation always disables lifecycle
scripts, and implicit filenames are compared with ASCII case folding so a
case-insensitive filesystem cannot reintroduce them. Future SDK, CLI, hosted,
deployable, release, or production-support distributions require separate
product, compatibility, security, and operational work.

This decision supersedes ADR 0014's earlier description of ADR 0013 TypeScript
exports as a "supported public API" only where that phrase implies a package or
SDK consumption model. Persisted JSON documents and schemas remain versioned
repository contracts, but there is no supported TypeScript package API.

## Consequences

- New readers can choose a supported entry point without inspecting package
  metadata.
- Customer setup continues to start from a clean customer-owned Git repository
  and exact-head repin workflow.
- Starter profiles and the full sandbox copy have separate documented command
  scopes; the profile does not claim the full evaluation matrix.
- Local release and starter evidence remains unsigned and non-authoritative.
- Internal TypeScript exports remain available to repository tests and tools but
  carry no external API compatibility promise.
- No model, script, package, or archive gains a credential, target, transition,
  administrative operation, or live-effect path.
- The retained `agentic-framework/v1alpha1` package, wire, schema, publisher, and
  cryptographic epoch remains unchanged.

## Rejected alternatives

- Publish the existing private package as an SDK: rejected because its internal
  barrel is broad, authority-sensitive, and not versioned as a supported API.
- Add a `bin` wrapper around repository scripts: rejected because their exact
  repository, Git history, profile, and external-prerequisite assumptions are
  not a general-purpose CLI contract.
- Describe interface code as a deployable or hosted control plane: rejected
  because the credential broker, protected stores, signer, runner, and trusted
  adapter services remain independently deployed prerequisites.
- Treat the customer-starter archive as an npm or production release: rejected
  because it is a mechanically closed source subset with non-authoritative
  no-go evidence.

## References

- [Distribution boundary](../architecture/distribution-boundary.md)
- [Compatibility matrix](../compatibility.md)
- [Customer evaluation guide](../../CUSTOMER_EVALUATION_GUIDE.md)
- [Customer-starter preflight](../release/customer-starter-preflight.md)
- [Packaging and replication](../architecture/packaging-and-replication.md)
- [Threat model](../security/threat-model.md)
- [Control matrix](../security/control-matrix.md)

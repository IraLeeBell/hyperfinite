# ADR 0004: Model outputs are target-free

- **Status:** Accepted
- **Date:** 2026-08-25

## Context

A model can be influenced by issue text, repository content, web pages, tool responses, or adversarial output. If it can name the repository object, branch, path, Project field, state, or effect to mutate, it can redirect trusted authority.

## Decision

All model-facing output schemas exclude authoritative targets and executable effects. Models may return artifacts such as findings, plans, patches, classifications, and review observations. Trusted Binding and deterministic routes supply targets after output validation. For implementation, the model emits logical slots and UTF-8 content only. Trusted code maps those slots to exact paths, validates the isolated Git diff, and persists the complete signed patch content with its base, tree, patch, plan, grant, model-output, threat-evidence, and Kernel-proof digests. After upload, an OIDC-authenticated invocation names the exact run, attempt, artifact ID, archive digest, and bundle digest. A separately deployed trusted consumer downloads that artifact with its App authority, verifies the workflow identity and full signed bundle, resolves the canonical binding, and invokes the Kernel-authorized GitHub adapter and Single Writer. The consumer creates one opaque, runtime-identity-checked freshness capability from the validated runtime policy and its trusted clock; its issuer is not exported, structural lookalikes cannot pass the guard, and concrete delivery and the adapter reuse that capability to recheck all runtime evidence at each mutation boundary. Commit creation must consume that exact signed bundle, apply its bytes to the authenticated parent tree, and fresh-read the resulting commit, tree, blobs, modes, content digests, and canonical parent-to-commit patch before completion evidence is accepted. Completed draft-PR replay requires the current PR-bound canonical binding and revalidates the fresh repository, Issue, Project, binding, and PR aggregate; only GitHub's mutable base-tip SHA may differ from immutable creation evidence.

The adapter rejects:

- repository, installation, organization, issue, PR, branch, Project, field, option, reviewer, or destination selectors;
- lifecycle states, route IDs, capability IDs, retry directives, or mutation verbs;
- shell commands or network destinations outside an explicitly declared artifact schema;
- unknown fields, oversized values, invalid references, or undeclared provenance.

## Decision drivers

- Confused-deputy prevention.
- Clear separation of judgment and authority.
- Provider-independent contracts.
- Simpler negative testing and auditability.

## Consequences

- Each model capability needs a narrow output schema and adapter.
- Free-form prose is stored as an artifact, never interpreted as control data.
- Deterministic code may reject an otherwise useful response.

## Rejected alternatives

- Model-selected targets followed by allowlist validation: rejected because authority begins in an untrusted zone.
- Natural-language commands parsed into effects: rejected because parsing ambiguity becomes an authorization boundary.
- Tool-calling directly against GitHub mutations: rejected for trusted workflows.

## Security and operational impact

Target injection is tested as a rejection case. Models receive no write credential. Single Writer obtains its own operation-scoped token only after independent policy evaluation.

## Open questions

- None for the current slice. `TargetFreePatch@1.0.0` plus the signed
  `TrustedValidatedPatchArtifact@1.0.0` handoff is the accepted representation;
  deployment of its delivery consumer remains separately gated.

## References

- [Architecture overview](../architecture/overview.md)
- [Work Accord](../architecture/work-contract.md)

# ADR 0002: Deterministic code owns mechanical authority

- **Status:** Accepted
- **Date:** 2026-08-25

## Context

Generative models are useful for judgment and content generation but are nondeterministic and exposed to untrusted instructions. Letting model output choose targets, permissions, transitions, retries, or mutations would create a confused-deputy path.

## Decision

Conventional code exclusively owns:

- event normalization and Trusted Binding;
- route and transition selection;
- actor and reviewer authorization;
- capability and credential authorization;
- retry, idempotency, concurrency, and budget policy;
- Project field/option selection;
- effect planning and GitHub mutations;
- final current-head and threat-result checks.

Models receive bounded evidence and return closed-schema, target-free advisory artifacts. The Control Kernel remains a pure state machine.

## Decision drivers

- Reproducibility and testability.
- Prompt-injection containment.
- Least privilege and clear accountability.
- Fail-closed handling of unknown states and outputs.
- Replay and incident forensics.

## Consequences

- More schemas, adapters, and deterministic tests are required.
- Some model flexibility is intentionally unavailable.
- Model success cannot directly imply a transition or write.
- Provider replacement is easier because authority remains outside the provider.

## Rejected alternatives

- Prompt-governed gates: rejected because compliant prose is not mechanical enforcement.
- Model-selected tools or targets with post-hoc validation: rejected because the model still controls the candidate authority surface.
- Broad write credentials in agent jobs: rejected because content and authority would share one trust boundary.

## Security and operational impact

Threat detection is a semantic control result, not merely a completed job. Any warning, skip, timeout, cancellation, malformed output, or inability to run blocks every privileged effect.

## Open questions

- Which bounded model outputs require independent model diversity in addition to deterministic validation?

## References

- [Architecture overview](../architecture/overview.md)
- [Capability Registry](../architecture/capability-registry.md)

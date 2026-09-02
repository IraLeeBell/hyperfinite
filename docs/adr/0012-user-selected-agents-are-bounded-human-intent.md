# ADR 0012: User-selected agents are bounded human intent, not authority

- **Status:** Accepted
- **Date:** 2026-08-30

## Context

Enterprise Project users benefit from choosing among reviewed agent styles at selected journey stages. A Project picklist is mutable user input, however, and cannot join the authority chain or dynamically choose an Agentic Workflow.

## Decision

`StageAgentBindingSet@2.0.0` declares `none`, `fixed`, or `user-selectable` participation independently from `executionKind`. Every stage declares actor eligibility, required evidence, exact option keys, exact static runtime candidates, `fallbackPolicy: none`, and clear-on-exit behavior.

Enterprise policy sets the maximum `locked`, `guided`, or `flexible` posture. Project policy can only narrow that ceiling. The Work Accord's `requestedCapabilities`, the current Phase Contract, stage policy, Capability Registry, Activation Lease, budget, run generation, receipt head, exact Project item, and current pull-request head narrow it again. Flexible still means an enumerated deny-by-default set.

`Requested Stage Agent` is the only human-editable intent field. Deterministic `resolveStageAgentSelection()` validates a fresh authenticated observation and issues one signed `SignedStageAgentSelectionGrant@1.0.0`. The grant contains one agent, skill, capability, workflow, workflow class, phase, role, input schema, output schema, tool ceiling, and budget ceiling. The scheduler receives that one exact grant; no model selects among candidates.

Accepted grants are atomically created and stably reread by selection key.
Trusted runtime state binds the exact grant digest plus authority epoch,
generation, run, attempt, receipt head, policy generation/digest, binding
digest, capability-registry digest, and budget-authority digest. Pre-activation finds one
immutable GitHub App-authored grant marker on the same stably read comment page,
validates its Ed25519 signature and exact Project/item/stage/agent/workflow/head
tuple, and only then permits redemption. A repository variable cannot stand in
for the grant.

Missing, invalid, stale, unauthorized, wrong-stage, cross-project, replayed, or conflicting intent has no fallback. Changing the picklist cannot retarget an accepted in-flight dispatch because the persisted dispatch and run fence bind the accepted grant digest. A later change requires reconciliation or a new authority generation.

Fixed agents remain non-user-invocable and are projected by exact trusted identity. Selectable agents may be invoked directly only as unbound advisory profiles; without a trusted stage-selection grant they return activation-required output that cannot advance a journey or satisfy evidence.

`Current Stage Agent`, `Stage Interaction`, and `Agent Selection Status` are display-only projections. `Requested Stage Agent` is structurally excluded from the projection mapping. GitHub Projects cannot conditionally filter one single-select option list by board column, so Adaptive Delivery exposes the full five-option catalog and deterministic code enforces the discovery-versus-implementation subset.

The Control Kernel still owns transitions and the Single Writer still owns effects. Selection grants contain no repository name, path, command, credential, route, transition, approval, merge, deployment, publication, or effect target.

## Consequences

- App Modernization, Feature Delivery, and Security Dependency Remediation remain locked.
- Adaptive Delivery is guided at Discovery Studio and Implementation Studio only.
- Every model-bearing workflow remains statically reviewed and compiler-owned.
- `StageAgentBindingSet@1.0.0` evidence is not reinterpreted. The v2 contract and dependent evidence are reissued; unknown versions fail closed.
- Live Project setup remains an exact-target, plan-confirm-apply-readback human-administration boundary.

## Rejected alternatives

- Dynamic `engine.agent` from Project or model text: rejected as authority injection.
- Default or fallback candidate: rejected because invalid intent must not cause inference.
- One conditionally filtered Project picklist per stage: unavailable in GitHub Projects and therefore enforced in trusted code.
- Reusing a signed selection after policy or generation drift: rejected as replay.

## References

- [Autonomous demo portfolio](../architecture/autonomous-demo-portfolio.md)
- [Demo runtime](../runtime/demo-runtime.md)
- [GitHub Project setup](../runbooks/github-project-setup.md)
- [Threat model](../security/threat-model.md)
- [Control matrix](../security/control-matrix.md)

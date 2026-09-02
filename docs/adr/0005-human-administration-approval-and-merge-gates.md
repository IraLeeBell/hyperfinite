# ADR 0005: Human administration, approval, and merge gates are non-bypassable

- **Status:** Proposed
- **Date:** 2026-08-25

## Context

Repository and organization administration, activation of cost-bearing work, acceptance of plans, approval of changes, and merge are high-impact decisions. Automation that can satisfy its own approval conditions collapses separation of duties.

## Decision

Humans retain:

- App installation and permission approval;
- repository, organization, Project, field, team, ruleset, visibility, billing, and policy administration;
- activation and material Work Accord changes;
- plan acceptance when policy requires it;
- independent PR review and approval;
- final merge and rollback authority;
- outbound licensing, publication, deployment, and production authorization.

The framework will not approve or merge its own changes. It verifies the reviewer by immutable identity, current permissions/team eligibility, approval state, and exact current head SHA. The task requester and automation identity do not count where policy requires an independent reviewer.

## Decision drivers

- Separation of duties.
- Protection from compromised automation.
- Current-head review integrity.
- Explicit authority for cost, release, and legal decisions.

## Consequences

- Some work waits for humans.
- Project/ruleset setup has a documented manual runbook.
- A green model verdict or check never substitutes for a review.
- Head changes invalidate prior automated evidence and, where required, human approval.

## Rejected alternatives

- Bot approval with branch protection as the only backstop: rejected because a bot can become its own gate.
- Agent-issued merge after a human comment: rejected because the decisive effect remains automated.
- PAT-backed administrator fallback: rejected because it bypasses scoped App authority and obscures accountability.

## Security and operational impact

The future App omits review and merge permissions. Rulesets/CODEOWNERS are defense in depth and must have no automation bypass actor. Authorization is checked at use time, not cached indefinitely.

## Open questions

- Which independence policies vary by risk tier or Domain Pack?

## References

- [Threat model](../security/threat-model.md)
- [Engineering thin slice](../architecture/thin-slice-plan.md)

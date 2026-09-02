# ADR 0001: GitHub is the authoritative system of record

- **Status:** Proposed
- **Date:** 2026-08-25

## Context

The framework needs durable work identity, human-visible state, review evidence,
and replayable delivery history without introducing a second operational
database. A private cache can improve performance, but two writable authorities
would create drift and ambiguous recovery.

## Decision

GitHub Issues, sub-issues/dependencies, Projects, pull requests, checks, reviews, comments, commits, and repository artifacts are authoritative. Projects are a visible materialized projection. Models and caches are never authoritative.

The framework reconstructs state from current GitHub facts, versioned Work Accords, and hash-chained receipts. It does not introduce a daemon, database, or queue in the initial implementation.

## Decision drivers

- Human visibility and ordinary GitHub review.
- Durable evidence and audit history.
- Rebuildable projections and deterministic reconciliation.
- Low operational surface.
- Native issue-to-PR delivery trace.

## Consequences

- GitHub rate limits, event delivery, editability, and API availability become design constraints.
- Receipts need tamper evidence and schema versioning.
- Actions provide scheduling, not authority.
- Project drift requires explicit detection and repair.
- Large evidence sets may later require protected-branch snapshots.

## Rejected alternatives

- A separate database as co-authority: rejected because recovery and conflict resolution become ambiguous.
- Model memory or chat history: rejected because it is mutable, incomplete, and not mechanically authoritative.
- Projects as the sole authority: rejected because fields are projections and human edits may be intent rather than valid transitions.

## Security and operational impact

The adapter must reread authoritative objects before every privileged effect. Caches are disposable. Every receipt binds immutable node/repository IDs, contract revisions, and exact SHAs.

## Open questions

- At what scale do receipt chains move from comments to protected-branch artifacts?
- Which GitHub Enterprise Server versions will be supported?

## References

- [Architecture overview](../architecture/overview.md)
- [Lifecycle](../architecture/lifecycle.md)

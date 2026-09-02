# ADR 0006: Open-source readiness is a gated assessment

- **Status:** Proposed
- **Date:** 2026-08-25

## Context

This repository contains an MIT `LICENSE` and deterministic release tooling.
Neither model output nor repository automation has authority to change licensing,
visibility, publication, or packaging policy.

## Decision

Preserve `LICENSE` byte-identically. License, visibility, and publication changes
remain governed human decisions.

No release is described as open-source ready until written owners approve:

- ownership and authority to license;
- source-level provenance and similarity review;
- notices, dependency inventory, and SBOM;
- outbound license, patent, copyleft, and CC compatibility;
- naming, trademark, screenshots, and compatibility claims;
- contributor terms and AI-assisted contribution disclosure;
- security, privacy, telemetry, support, and version policies;
- reproducible, signed, attested releases.

Possible future outcomes are: remain private; approved whole-project open source;
an approved public subset; approved dual license; or stop/replace uncleared
components.

## Decision drivers

- Asset-level rather than repository-level license reality.
- Trademark rights are separate from copyright licenses.
- Need for reversible, documented provenance.

## Consequences

- Publication, package distribution, repository visibility changes, and license edits are blocked.
- Adapted/verbatim reuse requires a complete disposition and human approval.
- `THIRD_PARTY_NOTICES.md` records any additional notices distributed with the
  repository.

## Rejected alternatives

- Silently replacing or narrowing the MIT license: rejected because automation lacks authority.
- Assuming a dependency's root license covers every asset: rejected because
  scope, notices, marks, patents, and similarity still require review.
- Treating private visibility as removal of prior grants: rejected; that legal conclusion requires counsel.

## Security and operational impact

Repository release tooling now emits deterministic unsigned SBOM, provenance,
attestation, checksum, and no-go evidence and rejects source, dependency,
notice, provenance, or evidence drift. It cannot consume approval evidence and
explicitly rejects any claim that its local attestation is trusted. This ADR
remains proposed because only authorized owners can decide whether any release
or open-source path should exist.

## Open questions

- Which outbound model, if any, will approved owners select?
- What contributor and AI-output ownership terms will apply?

## References

- [Reuse policy](../provenance/reuse-policy.md)
- [Open-source readiness assessment](../governance/open-source-readiness.md)

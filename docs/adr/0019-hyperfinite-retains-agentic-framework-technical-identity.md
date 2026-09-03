# ADR 0019: Hyperfinite retains the agentic-framework technical compatibility identity

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

The repository product is Hyperfinite, while its original lower-case
`agentic-framework` token already identifies package metadata, `v1alpha1` wire
contracts, JSON Schema URIs, Capability Registry publishers, release artifacts,
format markers, cryptographic domain separators, fixtures, and deterministic
expectations. Treating those values as stale branding would conflate display
prose with persisted technical identity.

The pre-decision tracked inventory contained 918 literal occurrences on 914
lines in 358 files. Every occurrence was classified before this decision:

| Classification | Occurrences | Matching lines | Base surfaces |
|---|---:|---:|---|
| Product-facing prose | 18 | 18 | Package description and Markdown/JSON titles or explanations |
| npm/package or release-manifest identity | 36 | 36 | Package/lock names, manifest package names, archive, builders, SPDX, attestation, and User-Agent values |
| API group or schema identifier | 671 | 671 | `apiVersion`, schema `$id`/`$ref`, logical Project schema and Project export formats |
| Capability Registry publisher identity | 35 | 35 | Base registry, four demo shards, and the deterministic generator |
| Cryptographic/domain-separation value | 23 | 21 | Runtime signatures/digests/redemption keys, budget domains, evidence markers, and escaping sentinels |
| Fixture, generated artifact, or deterministic test expectation | 135 | 133 | Examples, fixtures, and tests that reproduce or assert the values above |

Nine display/prose expectations still used the former product wording. They are
renamed to Hyperfinite without changing the technical identity they describe or
exercise.

## Decision

Retain one technical identifier epoch named `agentic-framework/v1alpha1`.
Hyperfinite is the only product-facing name. The required
`technicalIdentity` object in
`config/v1alpha1/compatibility.json` fixes the product name and the exact
package, archive, API version, schema origin, reusable Project schema name,
Capability Registry publisher, and domain stem. Its closed packaging schema
uses constants for every field.

The package remains `agentic-framework`; wire contracts remain
`agentic-framework.github.com/v1alpha1`; schema URIs remain below
`https://agentic-framework.github.com/schemas/`; Hyperfinite-owned capabilities
remain published by `agentic-framework`; and existing marker, builder, format,
User-Agent, signature, digest, and evidence domains retain their lower-case
stem. The reusable logical Project schema name remains
`agentic-framework-control-plane`, while its human-visible title is
`Hyperfinite Control Plane`.

`validate:technical-identity` scans the repository or extracted customer
starter, classifies every retained occurrence, and verifies the reviewed digest
of the ordered per-path, per-line inventory. Removing or replacing a domain,
marker, format, or release identifier therefore fails even when the replacement
no longer contains the retained stem. The validator also rejects stale
spaced/capitalized product spelling and unclassified uses, verifies package/lock
metadata, schema/API identity, registry publishers, and the Project display
boundary, and rejects Hyperfinite-shaped package, API, publisher, or domain
identifiers.

The compatibility contract binds distinct reviewed inventories for the
authoritative repository, `control-plane-core`, and `demo-portfolio`. Validation
accepts only an exact evidence match; deleting a marker file cannot select a
weaker scope.

Only the exact protected compatibility field and its exact closed-schema
property may declare the identifier epoch. Validation decodes JSON property
names, walks the schema structure, normalizes ASCII Unicode escapes in source,
and rejects every other declaration, including one elsewhere in the shared
packaging schema. Runtime jobs, model outputs, and migration documents expose no
identifier-epoch selector, so untrusted input cannot choose between identities
or request a migration.

## Compatibility and evidence consequences

- This is an identity retention, not a wire, package, publisher, signature, or
  stored-evidence migration. No compatibility alias or dual epoch is added.
- Existing exact-head release and customer-starter artifacts remain
  independently verifiable against their original source head. They are not
  rewritten, re-signed, or interpreted as evidence for a newer head.
- New exact-head evidence is regenerated normally. Its content and closure
  digests change when bound files or the source head change, while embedded
  technical identifiers remain stable.
- The compatibility document gains an explicit statement of values that were
  previously implicit. It does not grant authority or activate any runtime.
- The lifecycle graph, Work Accord, policy compiler, Control Kernel, trusted
  adapter, and Single Writer authority order is unchanged.

## Rejected alternative

A pre-release migration to Hyperfinite-shaped technical identifiers was
rejected because it would create a new package/wire/evidence epoch without a
customer requirement or authority benefit. It would require versioned
dual-read or explicit migration behavior across hundreds of schema and evidence
surfaces, invalidate stored signatures and domain-separated digests, and risk
making model/runtime/migration input an epoch selector. Product wording can be
corrected without that contract break.

## References

- [Compatibility matrix](../compatibility.md)
- [Architecture overview](../architecture/overview.md)
- [Capability Registry](../architecture/capability-registry.md)
- [Threat model](../security/threat-model.md)
- [Control matrix](../security/control-matrix.md)
- [`PackagingDocument` schema](../../schemas/v1alpha1/packaging.schema.json)
- [Packaging deterministic tests](../../tests/packaging.test.ts "non-bundle")

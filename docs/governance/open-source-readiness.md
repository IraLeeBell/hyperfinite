# Open-source readiness assessment

The machine-readable assessment is
`config/v1alpha1/open-source-readiness.json`. Its decision is `not-ready`, it is
non-authoritative, and every category remains an unresolved human gate.
Validation snapshots the complete assessment once so mutable input cannot change
after the `not-ready` decision is checked.

The curated snapshot defines the public-history boundary; it is not evidence
about earlier unpublished development. Unpublished issues, pull requests,
commits, or coordination records are not required by this assessment. Any
repository-history review covers the published source from that snapshot
forward.

| Category | Required human disposition |
|---|---|
| License, notice, provenance | Copyright-owner/counsel review of the repository license and outbound obligations; OSPO notice, provenance, similarity, patent, copyleft, and CC review |
| Contribution, security, governance | Contributor terms, AI-assisted contribution policy, code of conduct, governance, vulnerability handling |
| Dependency licensing | Human review of the SPDX SBOM and file-level obligations |
| Trademarks and branding | Product/legal approval of names, marks, screenshots, and compatibility claims |
| Secrets and customer data | Exact-head secret/privacy/customer-data review of the published source snapshot and public history, examples, logs, and artifacts |
| Support and SLA | Approved lifecycle, maintenance, deprecation, and support posture |
| Build reproducibility | Independent byte reproduction from the exact reviewed head |
| Release signing | Protected release identity/key custody, transparency, verification, and rotation |
| Internal references | Review for confidential internal or customer material |

The existing `LICENSE` is preserved byte-for-byte. `THIRD_PARTY_NOTICES.md`
records additional notices distributed with the repository. A generated SBOM,
clean scan, model review, or reproducible archive does not resolve ownership,
marks, privacy, support, or publication authority.

Automation is prohibited from deciding a license change, publication,
repository-visibility change, or release. Authorized legal, OSPO, security,
product, and maintainer owners must record evidence and decide outside the
framework.

The [customer-starter preflight report](../release/customer-starter-preflight.md)
provides additional non-authoritative evidence — deterministic secret/
internal-reference/customer-data scans and closure checks over a
configurable subset of the tree — for the same unresolved gates above. It
cannot resolve any category, change this assessment's `not-ready` decision,
or narrow the list of required human owners.

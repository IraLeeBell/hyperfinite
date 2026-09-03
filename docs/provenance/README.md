# Provenance

Public project history begins with a curated open-source snapshot. Earlier
private development history is intentionally not published. This repository is
the authoritative upstream for public development from that snapshot forward.
The snapshot makes no claim about earlier unpublished history. Unpublished
issues, pull requests, commits, or coordination records are not required for
public review, contribution, governance, or customer use.

Exact-head release and customer-starter provenance bind the reviewed public
source artifact and its materials; they do not extend the public-history
boundary. A customer-owned sandbox starts from its own reviewed file snapshot
and new evidence-chain root rather than inheriting upstream delivery history.

- [`reference-inventory.yml`](reference-inventory.yml) is the machine-readable
  inventory of reviewed sources. It is currently empty.
- [`reference-inventory.schema.json`](reference-inventory.schema.json) defines
  its closed structure.
- [Reuse policy](reuse-policy.md) defines original, conceptual, adapted, and
  verbatim classifications and their evidence requirements.

Run `npm run validate:provenance` after any inventory, notice, or reuse change.
Moving refs, missing pins, unsupported material claims, and unapproved adaptation
fail validation.

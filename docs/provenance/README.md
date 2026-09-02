# Provenance

- [`reference-inventory.yml`](reference-inventory.yml) is the machine-readable
  inventory of reviewed sources. It is currently empty.
- [`reference-inventory.schema.json`](reference-inventory.schema.json) defines
  its closed structure.
- [Reuse policy](reuse-policy.md) defines original, conceptual, adapted, and
  verbatim classifications and their evidence requirements.

Run `npm run validate:provenance` after any inventory, notice, or reuse change.
Moving refs, missing pins, unsupported material claims, and unapproved adaptation
fail validation.

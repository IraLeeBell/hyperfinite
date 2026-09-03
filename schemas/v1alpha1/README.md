# Version 1 alpha schemas

This is the current closed-schema family. See the
[schema guide](../README.md) for design rules and major groups.

`demo-projects/` contains per-demo artifact schemas and `domain-packs/` contains
Marketing and Business Operations artifact schemas. Files at this level define
shared lifecycle, runtime, GitHub, evidence, packaging, and portfolio contracts.
`technical-identity-inventory.schema.json` closes the separate reviewed
full-file identity evidence document.

Schema validity is necessary but not sufficient: semantic validators also
enforce canonical order, content digests, cross-document identity, target-free
output, lifecycle authority, and fail-closed security constraints.

The `agentic-framework.github.com/v1alpha1` API value and
`https://agentic-framework.github.com/schemas/` URI origin are retained
Hyperfinite compatibility identifiers. `compatibility.json` fixes the single
identifier epoch; runtime, model, and migration inputs cannot select another.

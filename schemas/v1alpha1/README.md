# Version 1 alpha schemas

This is the current closed-schema family. See the
[schema guide](../README.md) for design rules and major groups.

`demo-projects/` contains per-demo artifact schemas and `domain-packs/` contains
Marketing and Business Operations artifact schemas. Files at this level define
shared lifecycle, runtime, GitHub, evidence, packaging, and portfolio contracts.

Schema validity is necessary but not sufficient: semantic validators also
enforce canonical order, content digests, cross-document identity, target-free
output, lifecycle authority, and fail-closed security constraints.

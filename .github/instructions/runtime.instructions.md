---
applyTo: ".github/workflows/**,.github/agents/**,.github/skills/**,.github/aw/**,config/v1alpha1/copilot-runtime-policy.json,schemas/v1alpha1/copilot-runtime-policy.schema.json,src/copilot-runtime.ts,scripts/runtime-*.ts,tests/copilot-runtime.test.ts,tests/evals/**,docs/runtime/**"
---

# Copilot runtime instructions

- The Control Kernel is the only route and capability authority. A workflow dispatch is a request, not authorization.
- Run deterministic pre-activation checks before the agent job receives `copilot-requests: write` or starts a model.
- Bind every agent and skill to one immutable Capability Registry identity. Do not use wildcard, omitted, or inherited tool authority.
- Keep model output target-free and closed-schema. Select effect intent and concrete GitHub targets in trusted code.
- Require exact `success` threat-detection evidence; warnings, skips, missing evidence, or stale evidence fail closed.
- Keep external MCP disabled and network denied unless a future reviewed policy explicitly enumerates them.
- Never hand-edit `*.lock.yml` or `.github/aw/actions-lock.json`.
- Paid inference and privileged writes remain disabled until administrators supply reviewed variables, GitHub App configuration, Project binding, billing, and repository protections.

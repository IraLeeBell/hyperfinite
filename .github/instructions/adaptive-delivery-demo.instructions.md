---
applyTo: "config/v1alpha1/demo-projects/adaptive-delivery/**,schemas/v1alpha1/demo-projects/adaptive-delivery/**,examples/demos/adaptive-delivery/**,.github/agents/adaptive-delivery-*.agent.md,.github/skills/adaptive-delivery-*/**,.github/workflows/adaptive-delivery-*.md,tests/adaptive-delivery-demo.test.ts,tests/hybrid-agent-selection.test.ts,tests/fixtures/demos/adaptive-delivery/**,tests/evals/fixtures/adaptive-delivery-*.json,docs/demos/adaptive-delivery/**"
---

# Adaptive Delivery demo instructions

- Keep activation and paid inference disabled by default.
- Treat Requested Stage Agent as authenticated but untrusted human intent. Only deterministic policy intersection may issue one signed exact-agent grant.
- Fixed stages remain non-user-invocable. Selectable stages have no default or fallback candidate and accept only their reviewed option subset.
- Direct unbound invocation returns activation-required advisory output that cannot advance the journey or satisfy a gate.
- Keep output target-free and schema-bound. Trusted code owns repository, path, Project, item, route, transition, capability, credential, retry, and effect targets.
- Execution uses logical slots only. Verification is exact-current-head and COMMENT-only.
- Never approve, mark ready, dismiss review, merge, deploy, publish, enable live administration, expose credentials, or reinterpret Project fields as authority.

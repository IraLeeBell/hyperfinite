---
applyTo: "src/kernel.ts,src/policy.ts,src/copilot-runtime.ts,src/github-*.ts,tests/kernel.test.ts,tests/policy.test.ts,tests/copilot-runtime.test.ts"
---

# Trusted-kernel instructions

- Keep evaluation deterministic and side-effect free.
- Reject stale contract, lease, binding, policy, current-head, budget, replay, or evidence inputs rather than inferring defaults.
- Do not introduce network, environment, clock, credential, or filesystem reads into kernel evaluation.
- Return explicit refusal or reconciliation evidence; never silently downgrade an authorization failure.
- Keep target resolution and credential minting downstream of safe-output translation.

# Architecture decision records

ADRs record durable design decisions. An **Accepted** ADR governs repository
implementation. A **Proposed** ADR identifies a decision that still requires
the named human authority; repository code or model output cannot accept it.

| ADR | Status | Decision |
|---|---|---|
| [0001](0001-github-as-authoritative-system-of-record.md) | Proposed | GitHub as the authoritative system of record |
| [0002](0002-deterministic-mechanical-authority.md) | Accepted | Deterministic code owns mechanical authority |
| [0003](0003-primary-implementation-language.md) | Accepted | Strict TypeScript is the primary language |
| [0004](0004-target-free-model-outputs.md) | Accepted | Model outputs are target-free |
| [0005](0005-human-administration-approval-and-merge-gates.md) | Proposed | Human administration, approval, and merge gates are non-bypassable |
| [0006](0006-open-source-readiness-is-a-gated-assessment.md) | Proposed | Open-source readiness requires authorized human review |
| [0007](0007-domain-packs-are-policy-subordinate.md) | Accepted | Domain Packs are policy-subordinate repository specializations |
| [0008](0008-security-evidence-and-durable-replay.md) | Accepted | Security evidence is closed, deterministic, and durably claimed |
| [0009](0009-packaging-is-target-bound-and-release-evidence-is-non-authoritative.md) | Accepted | Packaging is target-bound and release evidence is non-authoritative |
| [0010](0010-autonomous-demo-portfolio-contracts-are-kernel-subordinate.md) | Accepted | Demo contracts remain Kernel-subordinate |
| [0011](0011-hermetic-readiness-is-not-live-activation.md) | Accepted | Hermetic readiness is evidence-gated and not live activation |
| [0012](0012-user-selected-agents-are-bounded-human-intent.md) | Accepted | User-selected agents are bounded human intent, not authority |
| [0013](0013-pre-app-deployment-app-and-administrator-contracts.md) | Accepted | Pre-App deployment, App registration, and administrator contracts are closed and fail closed |
| [0014](0014-durable-local-trust-substrate-is-nonproduction.md) | Accepted | The durable local trust store is a nonproduction substrate, not an authority |
| [0015](0015-customer-starter-and-open-source-preflight-tooling.md) | Accepted | Customer-starter and open-source-preflight tooling is additive, non-authoritative, and mechanically closed |
| [0016](0016-engineering-cost-holds-own-the-attempt-lifecycle.md) | Accepted | Engineering cost holds own the attempt lifecycle |
| [0017](0017-restart-safe-synthetic-canary-is-evidence-only.md) | Accepted | The restart-safe synthetic sandbox canary is credentialless evidence only |
| [0018](0018-administrator-handoff-is-plan-confirm-readback-only.md) | Accepted | The administrator handoff is plan, confirm, and readback only |
| [0019](0019-hyperfinite-retains-agentic-framework-technical-identity.md) | Accepted | Hyperfinite retains the `agentic-framework` technical compatibility identity |
| [0020](0020-supported-distribution-is-repository-and-customer-starter-source-only.md) | Accepted | Supported distribution is repository and customer-starter source only |
| [0021](0021-repository-about-metadata-is-human-administered-display-state.md) | Accepted | Repository About metadata is human-administered display state |

Do not rewrite accepted history to describe a new decision. Add a superseding
ADR when authority, security posture, or a durable contract changes.

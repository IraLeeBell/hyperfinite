# ADR 0011: Hermetic readiness is evidence-gated and is not live activation

- **Status:** Accepted three-demo baseline; four-demo cardinality and hybrid coverage expanded by [ADR 0012](0012-user-selected-agents-are-bounded-human-intent.md)
- **Date:** 2026-08-30

## Context

The three-demo portfolio has deterministic contracts, runtime boundaries, pack
assets, validators, and a real hermetic simulator. Its adversarial and
fault-injection evidence is distributed across test suites. Repository
integration must not be confused with provisioning Projects, installing a
GitHub App, deploying trust services, enabling paid inference, or completing
live activation.

## Decision

The repository carries one closed `DemoPortfolioHardeningPlan@1.0.0`. It is
non-authoritative test metadata: it cannot select a target, route, stage,
capability, credential, retry, effect, approval, or merge. The hardening gate:

1. validates the plan with strict duplicate-key rejection and a closed schema;
2. runs the named deterministic tests against the actual Kernel, runtime,
   adapter, Single Writer, Project, delivery, and recovery boundaries;
3. rejects failed, errored, skipped, todo, missing, or duplicate testcase
   evidence;
4. runs the real all-demo simulator twice and requires byte-identical output;
5. requires all 48 directed cross-demo substitutions to refuse before
   inference and effects; and
6. emits canonical evidence only when the closed fixture-declared external-call
   assertion set is present for each exact demo and every value is zero.

Every named scenario is projected over all three installed demos and combined
with a demo-specific pack anchor and the demo's actual simulator result. Fault
boundaries retain the rule that an ambiguous effect may be accepted only by
stable exact readback; otherwise it remains blocked.

Readiness has two distinct classifications:

- repository/hermetic-demo-ready, when the exact gate passes;
- sandbox/live blocked, until human administrators deploy and configure every
  prerequisite and an independently observed canary reaches Human Review.

Merging hardening evidence does not create a Project, install an App, request
live identifiers or secrets, deploy a service, enable billing or inference,
alter a ruleset, approve, dismiss, merge, deploy, publish, or release.

## Consequences

- One executable gate connects requested controls to actual boundary tests
  instead of relying on labels or prose assertions.
- The plan is closed and complete, but remains evidence selection rather than
  mechanical authority.
- Live Project visibility and sandbox use remain explicit post-merge human
  administration.
- Credentialed live fault injection, service SLOs, provider reconciliation, and
  platform drift still require an independently reviewed sandbox deployment.

## References

- [Autonomous demo portfolio](../architecture/autonomous-demo-portfolio.md)
- [Activation and readiness](../demos/portfolio/activation-and-readiness.md)
- [Threat-to-control matrix](../security/control-matrix.md)
- [Security evidence and durable replay](0008-security-evidence-and-durable-replay.md)
